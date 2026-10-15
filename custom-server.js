const crypto = require('node:crypto');
const core = require('./server');
const { server, io, rooms, makeRoom, publicRoom } = core;

const customGames = new Map();
const pendingJudgments = new Map();
const judgeTokens = new Map();
const judges = new Map();

function emit(room) {
  io.to(room.code).emit('state', publicRoom(room));
}

function text(value, max = 120) {
  return String(value || '').trim().slice(0, max);
}

function normalizeAliases(value) {
  if (Array.isArray(value)) return value.map(v => text(v, 80)).filter(Boolean).slice(0, 20);
  return String(value || '').split('|').map(v => text(v, 80)).filter(Boolean).slice(0, 20);
}

function validateAnswer(answer) {
  const label = text(answer?.text, 40).toUpperCase();
  const points = Number(answer?.points);
  if (!label || !Number.isInteger(points) || points < 0 || points > 100) throw new Error('Every answer needs a label and a whole-number point value from 0 to 100.');
  return { text: label, points, aliases: normalizeAliases(answer?.aliases) };
}

function validateBoard(board, expectedAnswers, label) {
  const question = text(board?.question, 180);
  if (!question) throw new Error(`${label} is missing its question.`);
  if (!Array.isArray(board?.answers) || board.answers.length !== expectedAnswers) throw new Error(`${label} must contain exactly ${expectedAnswers} answers.`);
  const answers = board.answers.map(validateAnswer);
  if (answers.reduce((sum, a) => sum + a.points, 0) !== 100 && label !== 'Sudden Death') throw new Error(`${label} answer points must total 100.`);
  return { question, answers };
}

function validateCustomGame(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('The uploaded game could not be read.');
  if (!Array.isArray(raw.rounds) || raw.rounds.length !== 4) throw new Error('A custom game needs four main rounds.');
  if (!Array.isArray(raw.fastMoney) || raw.fastMoney.length !== 5) throw new Error('A custom game needs five Fast Money questions.');
  const counts = [7, 6, 5, 4];
  return {
    title: text(raw.title, 60) || 'Custom Family Feud',
    rounds: raw.rounds.map((board, i) => validateBoard(board, counts[i], `Round ${i + 1}`)),
    suddenDeath: validateBoard(raw.suddenDeath, 1, 'Sudden Death'),
    fastMoney: raw.fastMoney.map((board, i) => validateBoard(board, 5, `Fast Money ${i + 1}`))
  };
}

function boardFor(room) {
  return room.round === 4 ? room.game.suddenDeath : room.game.rounds[room.round];
}

function judgePayload(room, pending) {
  if (pending.kind === 'main') {
    const board = boardFor(room);
    return {
      kind: 'main', code: room.code, guess: pending.given,
      contestant: room.players.find(p => p.id === pending.playerId)?.name || 'Contestant',
      question: board.question,
      answers: board.answers.map((a, index) => ({ index, text: a.text, points: a.points, revealed: room.revealed.includes(index) }))
    };
  }
  const q = room.game.fastMoney[pending.questionIndex];
  return {
    kind: 'fast', code: room.code, guess: pending.given,
    contestant: room.players.find(p => p.id === room.turnPlayerId)?.name || 'Contestant',
    question: q.question,
    answers: q.answers.map((a, index) => ({ index, text: a.text, points: a.points, revealed: false }))
  };
}

function requestJudgment(room, pending) {
  pendingJudgments.set(room.code, pending);
  room.inputLocked = true;
  emit(room);
  for (const judgeId of judges.get(room.code) || []) io.to(judgeId).emit('customJudgeNeeded', judgePayload(room, pending));
}

const normalRequestHandler = server.listeners('request')[0];
server.removeAllListeners('request');
server.on('request', (req, res) => {
  if (req.url === '/api/custom-config') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ customGameOnly: true, aiEnabled: false }));
  }
  return normalRequestHandler(req, res);
});

io.on('connection', socket => {
  const originalSubmitAnswer = socket.listeners('submitAnswer')[0];
  const originalSubmitFastAnswer = socket.listeners('submitFastAnswer')[0];
  socket.removeAllListeners('createRoom');
  socket.removeAllListeners('createTestRoom');
  socket.removeAllListeners('startGame');
  socket.removeAllListeners('submitAnswer');
  socket.removeAllListeners('submitFastAnswer');

  socket.on('createCustomRoom', ({ mode = 'host', era = 'random', game } = {}, reply) => {
    try {
      const cleanGame = validateCustomGame(game);
      const chosenEra = era === 'harvey' ? 'harvey' : era === 'dawson' ? 'dawson' : (Math.random() < 0.5 ? 'dawson' : 'harvey');
      const room = makeRoom(mode === 'remote' ? 'remote' : 'host', chosenEra);
      room.customGameOnly = true;
      room.customTitle = cleanGame.title;
      room.manualJudge = true;
      room.adminId = socket.id;
      socket.join(room.code);
      socket.data.roomCode = room.code;
      socket.data.isDisplay = false;
      const judgeToken = crypto.randomBytes(16).toString('hex');
      judgeTokens.set(room.code, judgeToken);
      judges.set(room.code, new Set([socket.id]));
      customGames.set(room.code, cleanGame);
      reply?.({ ok: true, code: room.code, mode: room.mode, judgeToken });
      emit(room);
    } catch (error) {
      reply?.({ ok: false, error: error.message || 'Could not create the custom game.' });
    }
  });

  socket.on('joinCustomJudge', ({ code, token } = {}, reply) => {
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room?.customGameOnly || token !== judgeTokens.get(room.code)) return reply?.({ ok: false, error: 'That host-control link is invalid or has expired.' });
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.isDisplay = false;
    (judges.get(room.code) || new Set()).add(socket.id);
    if (!judges.has(room.code)) judges.set(room.code, new Set([socket.id]));
    room.adminId = socket.id;
    reply?.({ ok: true, room: publicRoom(room) });
    const pending = pendingJudgments.get(room.code);
    if (pending) socket.emit('customJudgeNeeded', judgePayload(room, pending));
    emit(room);
  });

  socket.on('startGame', ({ code }, reply) => {
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room?.customGameOnly || !judges.get(room.code)?.has(socket.id) || room.phase !== 'lobby') return reply?.({ ok: false, error: 'Only the custom-game host can start this game.' });
    if (room.players.length < 2) return reply?.({ ok: false, error: 'At least two players are needed.' });
    const game = customGames.get(room.code);
    if (!game) return reply?.({ ok: false, error: 'This custom game is no longer available. Upload it again.' });
    room.game = structuredClone(game);
    const shuffled = [...room.players].sort(() => Math.random() - 0.5);
    const ids = [[], []];
    shuffled.forEach((p, i) => ids[i % 2].push(p.id));
    room.families = ids.map((playerIds, fi) => {
      const suggestions = playerIds.map(id => room.players.find(p => p.id === id)?.familyName).filter(Boolean);
      return { name: suggestions[Math.floor(Math.random() * suggestions.length)] || `Family ${fi + 1}`, playerIds };
    });
    room.phase = 'intro';
    room.introStartedAt = Date.now();
    room.message = 'It’s time for the Family Feud!';
    room.inputLocked = false;
    reply?.({ ok: true });
    emit(room);
  });

  socket.on('submitAnswer', (payload, reply) => {
    const room = rooms.get(String(payload?.code || '').toUpperCase());
    if (!room?.customGameOnly) return originalSubmitAnswer?.(payload, reply);
    const contestantId = socket.id;
    if (room.phase !== 'answer' || room.turnPlayerId !== contestantId || room.judging || room.inputLocked || payload.token !== room.answerToken) return reply?.({ ok: false, error: 'Please wait for your turn.' });
    const given = text(payload.answer, 80);
    if (!given) return reply?.({ ok: false, error: 'Enter an answer.' });
    clearTimeout(room.answerTimer); room.answerTimer = null; room.answerDeadline = null;
    requestJudgment(room, { kind: 'main', playerId: contestantId, given, token: payload.token, original: originalSubmitAnswer });
    reply?.({ ok: true });
  });

  socket.on('submitFastAnswer', (payload, reply) => {
    const room = rooms.get(String(payload?.code || '').toUpperCase());
    if (!room?.customGameOnly) return originalSubmitFastAnswer?.(payload, reply);
    if (room.phase !== 'fast_play' || room.turnPlayerId !== socket.id || room.judging || room.inputLocked || payload.questionIndex !== room.fastQuestionIndex || payload.fastIndex !== room.fastIndex || payload.attempt !== room.fastAttempt) return reply?.({ ok: false });
    const given = text(payload.answer, 80);
    if (!given) return reply?.({ ok: false });
    requestJudgment(room, { kind: 'fast', playerId: socket.id, given, questionIndex: payload.questionIndex, fastIndex: payload.fastIndex, attempt: payload.attempt, original: originalSubmitFastAnswer });
    reply?.({ ok: true });
  });

  socket.on('customJudgeDecision', ({ code, action, answerIndex } = {}, reply) => {
    const room = rooms.get(String(code || '').toUpperCase());
    const pending = room && pendingJudgments.get(room.code);
    if (!room?.customGameOnly || !pending || !judges.get(room.code)?.has(socket.id)) return reply?.({ ok: false, error: 'No answer is waiting for this host.' });
    const reject = action === 'reject';
    const answers = pending.kind === 'main' ? boardFor(room).answers : room.game.fastMoney[pending.questionIndex].answers;
    const index = Number(answerIndex);
    if (!reject && (!Number.isInteger(index) || index < 0 || index >= answers.length || (pending.kind === 'main' && room.revealed.includes(index)))) return reply?.({ ok: false, error: 'Choose an available board answer or reject the response.' });
    pendingJudgments.delete(room.code);
    room.inputLocked = false;
    room.judging = false;
    const canonical = reject ? `zzq-host-rejected-${Date.now()}` : answers[index].text;
    if (pending.kind === 'main') {
      pending.original?.({ code: room.code, answer: canonical, token: pending.token }, () => {});
    } else {
      const qi = pending.questionIndex;
      pending.original?.({ code: room.code, answer: canonical, questionIndex: qi, fastIndex: pending.fastIndex, attempt: pending.attempt }, () => {});
      setImmediate(() => {
        if (!room.customGameOnly) return;
        room.fastDraftAnswers[qi] = pending.given;
        room.fastDraftMatches ||= [];
        room.fastDraftMatches[qi] = { index: reject ? -1 : index, confidence: 1, manual: true };
      });
    }
    reply?.({ ok: true });
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    judges.get(code)?.delete(socket.id);
  });
});

const port = process.env.PORT || 3000;
server.listen(port, () => console.log(`Custom Family Feud running on http://localhost:${port} (AI disabled)`));
