const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs/promises');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { generateGamePackage, judgeAnswer, matchAnswer, newCode } = require('./src/game');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 2e6, pingTimeout: 30000 });
const rooms = new Map();

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_, res) => res.json({ ok: true, rooms: rooms.size }));
app.get('/api/room/:code/qr', async (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).end();
  const url = joinUrl(req, room.code);
  res.type('png').send(await QRCode.toBuffer(url, { width: 420, margin: 1, color: { dark: '#15120d', light: '#fff4c4' } }));
});
app.get('/api/room/:code/announcement', async (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room?.families?.length || !process.env.OPENAI_API_KEY) return res.status(204).end();
  try {
    if (!room.announcementAudio) room.announcementAudio = await createAnnouncement(room);
    res.type('audio/mpeg').send(room.announcementAudio);
  } catch (error) {
    console.error('AI announcer unavailable:', error.message);
    res.status(204).end();
  }
});
app.get('/api/room/:code/speech/:cueId', async (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  const cue = room?.speechCues?.get(Number(req.params.cueId));
  if (!room || !cue || !process.env.OPENAI_API_KEY) return res.status(204).end();
  try {
    if (!cue.audioPromise) cue.audioPromise = createHostSpeech(cue.text);
    const audio = await cue.audioPromise;
    if (!audio) return res.status(204).end();
    res.type('audio/mpeg').send(audio);
  } catch (error) {
    console.error('AI host speech unavailable:', error.message);
    res.status(204).end();
  }
});
app.get('/api/room/:code/kiss', (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  res.set('Cache-Control', 'no-store');
  if (!room?.kissImage) return res.status(204).end();
  res.type('image/png').send(room.kissImage);
});
app.get('*path', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

function joinUrl(req, code) {
  const base = process.env.PUBLIC_URL || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers['x-forwarded-host'] || req.headers.host}`;
  return `${base.replace(/\/$/, '')}/join/${code}`;
}

function makeRoom(mode) {
  let code; do code = newCode(); while (rooms.has(code));
  const room = {
    code, mode, phase: 'lobby', adminId: null, players: [], families: [], scores: [0, 0],
    game: null, round: -1, revealed: [], strikes: 0, bank: 0, faceoff: null,
    controlFamily: null, turnPlayerId: null, message: 'Waiting for players', winnerFamily: null,
    fastPlayers: [], fastAnswers: [null, null], fastScores: [null, null], fastMatches: [null, null], fastSelectorId: null, fastRevealIndex: null, fastRevealCount: 0, fastPrize: null,
    fastQuestionIndex: null, fastDraftAnswers: [], fastDeadline: null, inputLocked: false,
    answerDeadline: null, answerTimer: null, answerToken: 0, fastTimer: null,
    kissPlayerId: null, kissStatus: 'off', kissImage: null,
    speechCues: new Map(), cueCounter: 0, pendingCue: null, displayId: null, createdAt: Date.now()
  };
  rooms.set(code, room); return room;
}

function publicRoom(room) {
  const { announcementAudio, speechCues, fastSpeech, fastMatches, pendingCue, fastDraftAnswers, displayId, answerTimer, fastTimer, kissImage, ...safeRoom } = room;
  return {
    ...safeRoom,
    serverNow: Date.now(),
    pendingSpeech: pendingCue ? { cueId: pendingCue.cueId, text: speechCues.get(pendingCue.cueId)?.text, speechUrl: `/api/room/${room.code}/speech/${pendingCue.cueId}`, requiresAck: true } : null,
    players: room.players.map(({ familyName, kissConsent, ...p }) => p),
    game: room.game && room.phase !== 'lobby' && room.phase !== 'generating' ? {
      rounds: [...room.game.rounds, room.game.suddenDeath].map((r, i) => ({ answers: r.answers.map((a, ai) => ({ text: room.revealed.includes(ai) && i === room.round ? a.text : null, points: room.revealed.includes(ai) && i === room.round ? a.points : null })) })),
      fastMoney: room.game.fastMoney.map((q, i) => ({ question: canRevealFast(room, room.fastRevealIndex ?? 0, i) ? q.question : null }))
    } : null,
    fastAnswers: room.fastAnswers.map((answers, i) => answers?.map((answer, qi) => canRevealFast(room, i, qi) ? answer : null) ?? null),
    fastScores: room.fastScores.map((scores, i) => scores?.map((score, qi) => canRevealFast(room, i, qi) ? score : null) ?? null),
    fastTopAnswers: room.game ? room.game.fastMoney.map((q, qi) => canRevealFast(room, 1, qi) ? q.answers[0].text : null) : null
  };
}

function emit(room) { io.to(room.code).emit('state', publicRoom(room)); }
function player(room, id) { return room.players.find(p => p.id === id); }
function familyOf(room, id) { return room.families.findIndex(f => f.playerIds.includes(id)); }
function familyPlayers(room, fi) { return room.families[fi]?.playerIds.map(id => player(room, id)).filter(Boolean) || []; }
function boardFor(room, index = room.round) { return index === 4 ? room.game.suddenDeath : room.game.rounds[index]; }
function canRevealFast(room, index, questionIndex = 0) { return room.phase === 'fast_results' || ((room.phase === 'fast_reveal' || room.phase === 'fast_reveal_done') && (index < room.fastRevealIndex || (index === room.fastRevealIndex && questionIndex < room.fastRevealCount))); }
function emitCue(room, text, sound, speak = true, requiresAck = false) {
  const cueId = ++room.cueCounter;
  if (speak) {
    room.speechCues.set(cueId, { text, audioPromise: room.fastSpeech?.get(text) || null });
    while (room.speechCues.size > 80) room.speechCues.delete(room.speechCues.keys().next().value);
  }
  io.to(room.code).emit('cue', { cueId, text, sound, requiresAck, speechUrl: speak ? `/api/room/${room.code}/speech/${cueId}` : null });
  return cueId;
}
function setMessage(room, text, sound, speak = true) { room.message = text; emitCue(room, text, sound, speak); }

function runHostedCue(room, text, sound, onComplete, onStart = null) {
  cancelHostedCue(room);
  room.inputLocked = true;
  const cueId = emitCue(room, text, sound, true, true);
  // A slow API or suspended phone must never silently advance the game.
  room.pendingCue = { cueId, onComplete, onStart, started: false };
  emit(room);
}

function cancelHostedCue(room) {
  if (!room.pendingCue) return;
  const { cueId } = room.pendingCue;
  room.pendingCue = null;
  io.to(room.code).emit('cancelCue', { cueId });
}

function finishHostedCue(room, cueId) {
  if (!room.pendingCue || room.pendingCue.cueId !== cueId) return;
  const complete = room.pendingCue.onComplete;
  room.pendingCue = null;
  complete?.();
}

function clearAnswerClock(room) {
  clearTimeout(room.answerTimer); room.answerTimer = null; room.answerDeadline = null;
}

function openAnswer(room, playerId) {
  clearAnswerClock(room);
  room.phase = 'answer'; room.turnPlayerId = playerId; room.inputLocked = false;
  const contestant = player(room, playerId), token = ++room.answerToken;
  room.answerDeadline = Date.now() + 5000;
  room.answerTimer = setTimeout(() => {
    if (room.phase === 'answer' && room.answerToken === token && !room.judging) void resolveAnswer(room, contestant, '', true);
  }, 5000);
  emit(room);
}

function revealSlot(room, index) {
  if (!room.revealed.includes(index)) room.revealed.push(index);
  emit(room);
  io.to(room.code).emit('boardReveal', { round: room.round, index });
}

async function resolveAnswer(room, contestant, given, timedOut = false) {
  if (room.judging || room.phase !== 'answer') return;
  clearAnswerClock(room); room.judging = true; room.inputLocked = true; emit(room);
  const board = boardFor(room);
  let match;
  try { match = timedOut ? { index: -1 } : await judgeAnswer(given, board.answers, room.revealed); }
  catch { match = matchAnswer(given, board.answers, room.revealed); }
  const finish = () => {
    room.judging = false; room.inputLocked = false;
    if (room.round === 4 && match.index >= 0) awardSuddenDeath(room, familyOf(room, contestant.id));
    else handleAnswer(room, contestant.id, match.index);
    emit(room);
  };
  const showResult = () => {
    if (match.index >= 0) {
      const answer = board.answers[match.index];
      room.bank += answer.points * multiplier(room.round); revealSlot(room, match.index);
      runHostedCue(room, `${answer.text}! ${answer.points} people gave that answer.`, null, finish);
    } else {
      const count = room.controlFamily === null || room.isSteal ? 1 : Math.min(3, room.strikes + 1);
      io.to(room.code).emit('answerResult', { correct: false, count, timedOut });
      runHostedCue(room, timedOut ? 'Time is up!' : 'That answer is not on the board.', 'strike', finish);
    }
  };
  room.message = timedOut ? `${contestant.name} ran out of time.` : `${contestant.name} said ${given}.`;
  if (timedOut) showResult();
  else runHostedCue(room, `${contestant.name} said ${given}. Survey says…`, null, showResult);
}

io.on('connection', socket => {
  socket.on('createRoom', ({ mode = 'host' } = {}, reply) => {
    const room = makeRoom(mode === 'remote' ? 'remote' : 'host');
    socket.join(room.code); socket.data.roomCode = room.code; socket.data.isDisplay = mode === 'host';
    if (room.mode === 'host') room.displayId = socket.id;
    reply?.({ ok: true, code: room.code, mode: room.mode }); emit(room);
  });

  socket.on('watchRoom', ({ code }, reply) => {
    const room = rooms.get(String(code).toUpperCase());
    if (!room) return reply?.({ ok: false, error: 'That game no longer exists.' });
    socket.join(room.code); socket.data.roomCode = room.code; socket.data.isDisplay = true;
    if (room.mode === 'host') room.displayId = socket.id;
    reply?.({ ok: true, room: publicRoom(room) }); emit(room);
  });

  socket.on('joinRoom', ({ code, name, familyName, photo, kissConsent = false }, reply) => {
    const room = rooms.get(String(code).toUpperCase());
    if (!room || room.phase !== 'lobby') return reply?.({ ok: false, error: 'That lobby is unavailable.' });
    if (room.players.length >= 10) return reply?.({ ok: false, error: 'This game is full. Family Feud supports a maximum of 10 players.' });
    if (!name?.trim() || !familyName?.trim() || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photo || '')) return reply?.({ ok: false, error: 'Name, photo, and family name are required.' });
    if (photo.length > 1_500_000) return reply?.({ ok: false, error: 'Please use a smaller photo.' });
    const p = { id: socket.id, name: name.trim().slice(0, 24), familyName: familyName.trim().replace(/\s+family$/i, '').slice(0, 24), photo, kissConsent: kissConsent === true, connected: true };
    room.players.push(p); if (!room.adminId) room.adminId = p.id;
    socket.join(room.code); socket.data.roomCode = room.code; socket.data.playerId = p.id;
    reply?.({ ok: true, playerId: p.id, isAdmin: room.adminId === p.id, mode: room.mode }); emit(room);
  });

  socket.on('rejoin', ({ code, playerId }, reply) => {
    const room = rooms.get(String(code).toUpperCase()); const p = room && player(room, playerId);
    if (!p) return reply?.({ ok: false });
    const oldId = p.id; p.id = socket.id; p.connected = true;
    room.players.forEach(x => { if (x.id === oldId) x.id = socket.id; });
    room.families.forEach(f => { f.playerIds = f.playerIds.map(id => id === oldId ? socket.id : id); });
    if (room.faceoff?.players) room.faceoff.players = room.faceoff.players.map(id => id === oldId ? socket.id : id);
    if (room.faceoff?.buzzedBy === oldId) room.faceoff.buzzedBy = socket.id;
    room.faceoff?.attempts?.forEach(a => { if (a.playerId === oldId) a.playerId = socket.id; });
    if (room.kissPlayerId === oldId) room.kissPlayerId = socket.id;
    if (room.adminId === oldId) room.adminId = socket.id;
    if (room.turnPlayerId === oldId) room.turnPlayerId = socket.id;
    if (room.fastSelectorId === oldId) room.fastSelectorId = socket.id;
    if (room.displayId === oldId) room.displayId = socket.id;
    room.fastPlayers = room.fastPlayers.map(id => id === oldId ? socket.id : id);
    socket.join(room.code); socket.data.roomCode = room.code; socket.data.playerId = socket.id;
    reply?.({ ok: true, playerId: socket.id, isAdmin: room.adminId === socket.id, mode: room.mode }); emit(room);
  });

  socket.on('cueFinished', ({ code, cueId }) => {
    const room = rooms.get(String(code).toUpperCase());
    if (!room || !room.pendingCue || Number(cueId) !== room.pendingCue.cueId) return;
    const controller = room.mode === 'host' ? room.displayId : room.adminId;
    if (socket.id !== controller) return;
    finishHostedCue(room, Number(cueId));
  });

  socket.on('cueStarted', ({ code, cueId }) => {
    const room = rooms.get(String(code).toUpperCase());
    const controller = room?.mode === 'host' ? room.displayId : room?.adminId;
    if (!room?.pendingCue || room.pendingCue.cueId !== Number(cueId) || socket.id !== controller || room.pendingCue.started) return;
    room.pendingCue.started = true; room.pendingCue.onStart?.();
  });

  socket.on('startGame', async ({ code }, reply) => {
    const room = rooms.get(String(code).toUpperCase());
    if (!room || socket.id !== room.adminId || room.phase !== 'lobby') return reply?.({ ok: false, error: 'Only the first player can start.' });
    if (room.players.length < 2) return reply?.({ ok: false, error: 'At least two players are needed.' });
    room.phase = 'generating'; setMessage(room, 'OpenAI is preparing tonight’s surveys…', null, false); emit(room); reply?.({ ok: true });
    const kissTask = prepareKissImage(room);
    room.game = await generateGamePackage();
    // Warm only the five shared Fast Money questions; both contestants reuse them.
    if (process.env.OPENAI_API_KEY) room.fastSpeech = new Map(room.game.fastMoney.map((q, i) => {
      const text = `Question ${i + 1}. ${q.question}`;
      return [text, createHostSpeech(text).catch(() => null)];
    }));
    const shuffled = [...room.players].sort(() => Math.random() - .5);
    const ids = [[], []]; shuffled.forEach((p, i) => ids[i % 2].push(p.id));
    room.families = ids.map((playerIds, fi) => {
      const suggestions = playerIds.map(id => player(room, id).familyName).filter(Boolean);
      return { name: suggestions[Math.floor(Math.random() * suggestions.length)] || `Family ${fi + 1}`, playerIds };
    });
    await kissTask;
    room.phase = 'intro'; room.introStartedAt = Date.now(); setMessage(room, 'It’s time for the Family Feud!', null, false); emit(room);
  });

  socket.on('introComplete', ({ code }) => {
    const room = rooms.get(String(code).toUpperCase());
    if (!room || (socket.id !== room.adminId && !socket.data.isDisplay) || room.phase !== 'intro') return;
    beginRound(room, 0);
  });

  socket.on('buzz', ({ code }) => {
    const room = rooms.get(String(code).toUpperCase());
    if (!room || room.phase !== 'faceoff' || !room.faceoff?.canBuzz || room.faceoff.buzzedBy || !room.faceoff.players.includes(socket.id)) return;
    room.faceoff.buzzedBy = socket.id; room.faceoff.canBuzz = false;
    cancelHostedCue(room);
    room.message = `${player(room, socket.id).name} buzzed in! Five seconds.`;
    emitCue(room, room.message, 'buzz', false); openAnswer(room, socket.id);
  });

  socket.on('submitAnswer', ({ code, answer, token }, reply) => {
    const room = rooms.get(String(code).toUpperCase());
    if (!room || room.phase !== 'answer' || room.turnPlayerId !== socket.id || room.judging || room.inputLocked || token !== room.answerToken) return reply?.({ ok: false, error: 'Please wait for your turn.' });
    if (Date.now() >= room.answerDeadline) { void resolveAnswer(room, player(room, socket.id), '', true); return reply?.({ ok: false, error: 'Time is up.' }); }
    const given = String(answer || '').trim().slice(0, 80);
    if (!given) return reply?.({ ok: false, error: 'Enter an answer.' });
    reply?.({ ok: true }); void resolveAnswer(room, player(room, socket.id), given);
  });

  socket.on('playOrPass', ({ code, choice }) => {
    const room = rooms.get(String(code).toUpperCase());
    if (!room || room.phase !== 'decision' || familyOf(room, socket.id) !== room.faceoff.winnerFamily) return;
    room.controlFamily = choice === 'pass' ? 1 - room.faceoff.winnerFamily : room.faceoff.winnerFamily;
    startFamilyTurn(room);
  });

  socket.on('nextRound', ({ code }) => {
    const room = rooms.get(String(code).toUpperCase());
    if (!room || socket.id !== room.adminId || room.phase !== 'round_end') return;
    if (room.round < 3) beginRound(room, room.round + 1);
    else if (room.round === 3 && Math.max(...room.scores) < 300) beginRound(room, 4);
    else beginFastMoney(room);
  });

  socket.on('selectFastPlayers', ({ code, playerIds }) => {
    const room = rooms.get(String(code).toUpperCase());
    if (!room || room.phase !== 'fast_select' || socket.id !== room.fastSelectorId) return;
    const winner = room.winnerFamily ?? (room.scores[0] >= room.scores[1] ? 0 : 1);
    const valid = [...new Set(playerIds)].filter(id => room.families[winner].playerIds.includes(id));
    if (valid.length !== 2) return;
    room.fastPlayers = valid; startFastPlayer(room, 0);
  });

  socket.on('submitFastAnswer', ({ code, answer, questionIndex, fastIndex }, reply) => {
    const room = rooms.get(String(code).toUpperCase());
    if (!room || room.phase !== 'fast_play' || room.turnPlayerId !== socket.id || room.judging || room.inputLocked || questionIndex !== room.fastQuestionIndex || fastIndex !== room.fastIndex) return reply?.({ ok: false });
    if (Date.now() >= room.fastDeadline) { void finishFastPlayer(room); return reply?.({ ok: false }); }
    reply?.({ ok: true });
    room.fastDraftAnswers[room.fastQuestionIndex] = String(answer || '').trim().slice(0, 80);
    if (room.fastQuestionIndex >= 4) return finishFastPlayer(room);
    room.fastQuestionIndex++;
    askFastQuestion(room);
  });

  socket.on('fastTimeout', ({ code }) => {
    const room = rooms.get(String(code).toUpperCase());
    if (!room || room.phase !== 'fast_play' || room.turnPlayerId !== socket.id || room.judging || Date.now() < room.fastDeadline) return;
    while (room.fastDraftAnswers.length < 5) room.fastDraftAnswers.push('');
    finishFastPlayer(room);
  });

  socket.on('continueFastMoney', ({ code }) => {
    const room = rooms.get(String(code).toUpperCase());
    if (!room || room.phase !== 'fast_reveal_done' || socket.id !== room.fastSelectorId) return;
    if (room.fastRevealIndex === 0) startFastPlayer(room, 1);
    else {
      const total = room.fastScores.flat().reduce((a, b) => a + b, 0);
      room.phase = 'fast_results'; room.turnPlayerId = null;
      setMessage(room, total >= 200 ? `You scored ${total} points and won $10,000!` : `You scored ${total} points and won $${room.fastPrize.toLocaleString()}!`, 'win'); emit(room);
    }
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomCode); const p = room && player(room, socket.id);
    if (p) { p.connected = false; emit(room); }
  });
});

function beginRound(room, index) {
  clearAnswerClock(room);
  room.round = index; room.revealed = []; room.strikes = 0; room.bank = 0; room.controlFamily = null;
  const p0 = familyPlayers(room, 0)[index % familyPlayers(room, 0).length];
  const p1 = familyPlayers(room, 1)[index % familyPlayers(room, 1).length];
  room.faceoff = { players: [p0.id, p1.id], buzzedBy: null, attempts: [], winnerFamily: null, canBuzz: false };
  room.phase = 'faceoff'; room.turnPlayerId = null;
  const opening = index === 4 ? 'Sudden Death.' : `Round ${index + 1}.`;
  room.message = `${opening} The host is calling the faceoff players.`;
  runHostedCue(room, `${opening} Let's have ${p0.name}. Let's have ${p1.name}.`, 'round', () => readFaceoffQuestion(room));
}

function readFaceoffQuestion(room) {
  room.phase = 'faceoff'; room.faceoff.canBuzz = false;
  room.message = 'Listen and buzz as soon as you know your answer.';
  runHostedCue(room, `We asked 100 people: ${boardFor(room).question}`, null, () => {
    room.faceoff.canBuzz = true; room.inputLocked = false; emit(room);
  }, () => {
    room.faceoff.canBuzz = true; emit(room);
  });
}

function handleAnswer(room, playerId, answerIndex) {
  if (room.faceoff && room.controlFamily === null) return handleFaceoffAnswer(room, playerId, answerIndex);
  if (room.phase !== 'answer') return;
  if (room.isSteal) return awardRound(room, answerIndex >= 0 ? room.controlFamily : 1 - room.controlFamily);
  if (answerIndex < 0) room.strikes++;
  if (room.revealed.length === boardFor(room).answers.length) return awardRound(room, room.controlFamily);
  if (room.strikes >= 3) {
    room.controlFamily = 1 - room.controlFamily; room.isSteal = true;
    const stealer = familyPlayers(room, room.controlFamily)[0].id;
    return promptForAnswer(room, stealer, `${room.families[room.controlFamily].name} family can steal. ${player(room, stealer).name}, give one answer.`, 'strike');
  }
  advanceTurn(room);
}

function handleFaceoffAnswer(room, playerId, answerIndex) {
  room.faceoff.attempts.push({ playerId, answerIndex });
  const other = room.faceoff.players.find(id => id !== playerId);
  if (room.faceoff.attempts.length === 1 && answerIndex !== 0) {
    return promptForAnswer(room, other, `Let me read ${player(room, other).name} the entire question before they answer. ${boardFor(room).question}`);
  }
  const attempts = room.faceoff.attempts.filter(x => x.answerIndex >= 0).sort((a, b) => a.answerIndex - b.answerIndex);
  if (!attempts.length && room.faceoff.attempts.length < 2) { room.turnPlayerId = other; return; }
  if (!attempts.length) {
    room.faceoff.attempts = []; room.faceoff.buzzedBy = null; room.turnPlayerId = null; room.phase = 'faceoff';
    room.faceoff.canBuzz = false;
    return runHostedCue(room, 'Neither answer made the survey. Let us try again.', null, () => readFaceoffQuestion(room));
  }
  const winner = attempts[0];
  room.faceoff.winnerFamily = familyOf(room, winner.playerId);
  room.turnPlayerId = winner.playerId; room.phase = 'host_wait';
  runHostedCue(room, `${room.families[room.faceoff.winnerFamily].name} family, play or pass?`, 'reveal', () => {
    room.phase = 'decision'; room.inputLocked = false; emit(room);
  });
}

function startFamilyTurn(room) {
  room.strikes = 0; room.isSteal = false;
  const members = familyPlayers(room, room.controlFamily);
  const face = room.faceoff.players.find(id => familyOf(room, id) === room.controlFamily);
  const index = Math.max(0, members.findIndex(p => p.id === face));
  const next = members[(index + 1) % members.length].id;
  promptForAnswer(room, next, `${room.families[room.controlFamily].name} family is playing. ${player(room, next).name}, your answer!`);
}

function advanceTurn(room) {
  const members = familyPlayers(room, room.controlFamily); const index = members.findIndex(p => p.id === room.turnPlayerId);
  const next = members[(index + 1) % members.length].id;
  promptForAnswer(room, next, `${player(room, next).name}, your answer!`);
}

function promptForAnswer(room, playerId, text, sound) {
  room.phase = 'host_wait'; room.turnPlayerId = playerId; room.message = text;
  runHostedCue(room, text, sound, () => {
    openAnswer(room, room.turnPlayerId);
  });
}

function awardRound(room, familyIndex) {
  room.scores[familyIndex] += room.bank; room.phase = 'round_reveal'; room.turnPlayerId = null; room.isSteal = false;
  const remaining = boardFor(room).answers.map((_, i) => i).filter(i => !room.revealed.includes(i));
  room.message = `${room.families[familyIndex].name} family wins ${room.bank} points!`;
  runHostedCue(room, room.message + (remaining.length ? ` Let's reveal the answers left on the board.` : ''), 'win', () => revealRemainingAnswer(room, remaining));
}

function revealRemainingAnswer(room, remaining) {
  if (!remaining.length) {
    room.phase = 'round_end'; room.inputLocked = false; emit(room); return;
  }
  const index = remaining.shift(); const answer = boardFor(room).answers[index];
  room.message = `${answer.text} — ${answer.points}`; revealSlot(room, index);
  runHostedCue(room, `Number ${index + 1}. ${answer.text}. ${answer.points} people gave that answer.`, null, () => revealRemainingAnswer(room, remaining));
}

function beginFastMoney(room) {
  room.round = -1; clearAnswerClock(room);
  const winner = room.winnerFamily ?? (room.scores[0] >= room.scores[1] ? 0 : 1);
  const winners = room.families[winner].playerIds;
  room.fastSelectorId = winners[0];
  if (winners.length === 1) {
    room.fastPlayers = [winners[0], winners[0]]; startFastPlayer(room, 0); return;
  }
  room.phase = 'fast_select'; room.turnPlayerId = null;
  setMessage(room, `${room.families[winner].name} family wins the game! ${player(room, room.fastSelectorId).name}, as team leader, choose two players for Fast Money.`, 'win'); emit(room);
}

function awardSuddenDeath(room, familyIndex) {
  const points = boardFor(room).answers[0].points * 3;
  room.scores[familyIndex] += points; room.winnerFamily = familyIndex; room.phase = 'host_wait'; room.turnPlayerId = null;
  room.revealed = [0];
  room.message = `${room.families[familyIndex].name} family wins Sudden Death and the game with ${points} points!`;
  runHostedCue(room, room.message, 'win', () => {
    room.phase = 'round_end'; room.inputLocked = false; emit(room);
  });
}

function startFastPlayer(room, index) {
  clearTimeout(room.fastTimer);
  room.phase = 'host_wait'; room.fastIndex = index; room.fastRevealIndex = null; room.fastRevealCount = 0; room.fastQuestionIndex = 0; room.fastDraftAnswers = []; room.fastDeadline = null; room.turnPlayerId = room.fastPlayers[index];
  const seconds = index === 0 ? 45 : 60; const name = player(room, room.turnPlayerId).name;
  room.message = `${name} is getting ready for Fast Money.`;
  runHostedCue(room, `${name}, you have ${seconds} seconds. Listen carefully and answer each question as quickly as you can.`, 'fast', () => {
    room.phase = 'fast_play'; room.fastDeadline = Date.now() + seconds * 1000;
    room.fastTimer = setTimeout(() => void finishFastPlayer(room), seconds * 1000);
    askFastQuestion(room);
  });
}

function askFastQuestion(room) {
  if (room.phase !== 'fast_play') return;
  const question = room.game.fastMoney[room.fastQuestionIndex].question;
  room.message = `Fast Money question ${room.fastQuestionIndex + 1} of 5. Listen to the host.`;
  runHostedCue(room, `Question ${room.fastQuestionIndex + 1}. ${question}`, 'fast', () => {
    if (room.phase !== 'fast_play') return;
    room.inputLocked = false; emit(room);
  });
}

function startFastReveal(room, index) {
  room.phase = 'fast_reveal'; room.fastRevealIndex = index; room.fastRevealCount = 0; room.fastDeadline = null;
  room.message = `Let's reveal ${player(room, room.fastPlayers[index]).name}'s answers.`;
  revealNextFastAnswer(room);
}

async function finishFastPlayer(room) {
  if (room.judging || room.phase !== 'fast_play') return;
  clearTimeout(room.fastTimer); room.fastTimer = null; cancelHostedCue(room);
  room.judging = true; room.inputLocked = true; room.phase = 'fast_judging'; room.fastDeadline = null; emit(room);
  const idx = room.fastIndex;
  const clean = Array.from({ length: 5 }, (_, i) => String(room.fastDraftAnswers[i] || '').slice(0, 80));
  room.fastAnswers[idx] = clean;
  const judgments = await Promise.all(clean.map(async (guess, qi) => {
    if (!guess) return { index: -1 };
    try { return await judgeAnswer(guess, room.game.fastMoney[qi].answers); }
    catch { return matchAnswer(guess, room.game.fastMoney[qi].answers); }
  }));
  room.fastMatches[idx] = judgments.map(j => j.index);
  room.fastScores[idx] = judgments.map((judgment, qi) => {
    const repeated = idx === 1 && ((judgment.index >= 0 && judgment.index === room.fastMatches[0]?.[qi]) || normalizeLoose(clean[qi]) === normalizeLoose(room.fastAnswers[0]?.[qi]));
    return !repeated && judgment.index >= 0 ? room.game.fastMoney[qi].answers[judgment.index].points : 0;
  });
  room.judging = false; room.turnPlayerId = null;
  if (idx === 1) { const total = room.fastScores.flat().reduce((a, b) => a + b, 0); room.fastPrize = total >= 200 ? 10000 : total * 5; }
  startFastReveal(room, idx);
}

function revealNextFastAnswer(room) {
  if (room.fastRevealCount >= 5) {
    room.phase = 'fast_reveal_done'; room.inputLocked = false;
    room.message = `${player(room, room.fastPlayers[room.fastRevealIndex]).name}'s reveal is complete.`; emit(room); return;
  }
  const i = room.fastRevealCount++; const idx = room.fastRevealIndex; const q = room.game.fastMoney[i];
  const guess = room.fastAnswers[idx][i] || 'no answer'; const points = room.fastScores[idx][i] || 0;
  const top = idx === 1 ? ` The number one answer was ${q.answers[0].text}.` : '';
  room.message = `${guess} — ${points} points`;
  runHostedCue(room, `Question ${i + 1}. ${q.question} ${player(room, room.fastPlayers[idx]).name} said ${guess}. That scored ${points} points.${top}`, null, () => revealNextFastAnswer(room));
  io.to(room.code).emit('boardReveal', { fastIndex: idx, index: i });
}

function multiplier(round) { return round < 2 ? 1 : round === 2 ? 2 : 3; }
function normalizeLoose(v) { return String(v || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

async function prepareKissImage(room) {
  const volunteers = room.players.filter(p => p.kissConsent);
  if (!volunteers.length) return;
  const chosen = volunteers[Math.floor(Math.random() * volunteers.length)];
  room.kissPlayerId = chosen.id;
  if (!process.env.OPENAI_API_KEY) { room.kissStatus = 'unavailable'; return; }
  room.kissStatus = 'preparing';
  try {
    const source = await fs.readFile(path.join(__dirname, 'assets', 'dawson-kiss-source.png'));
    const [, mime, base64] = chosen.photo.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
    const form = new FormData();
    form.append('model', process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2');
    form.append('image[]', new Blob([source], { type: 'image/png' }), 'scene.png');
    form.append('image[]', new Blob([Buffer.from(base64, 'base64')], { type: mime }), 'participant.' + mime.split('/')[1]);
    form.append('prompt', 'Create a clearly fictional home-game photo souvenir using the first image as the scene. Replace ONLY the adult contestant on the right with the consenting adult participant shown in the second image, preserving their facial identity and natural head orientation. Keep Richard Dawson on the left unchanged, preserve the microphones, clothes, blue set, vintage photographic texture and composition. Maintain the same brief, nonsexual, closed-mouth game-show greeting kiss. No nudity, no sexualization. Do not add or change other people. This will be displayed as an AI-edited novelty image, not a real event.');
    const response = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: form, signal: AbortSignal.timeout(90000)
    });
    if (!response.ok) throw new Error(`Image API ${response.status}`);
    const result = await response.json();
    if (!result.data?.[0]?.b64_json) throw new Error('Image API returned no image');
    room.kissImage = Buffer.from(result.data[0].b64_json, 'base64'); room.kissStatus = 'ready';
  } catch (error) {
    room.kissStatus = 'unavailable'; console.warn('Optional intro photo unavailable:', error.message);
  }
}

function disposeRoom(room) {
  clearAnswerClock(room); clearTimeout(room.fastTimer); cancelHostedCue(room); rooms.delete(room.code);
}

async function createAnnouncement(room) {
  const lines = room.families.map(f => `Introducing the ${f.name} family! ${f.playerIds.map(id => player(room, id).name).join(', ')}!`).join(' And now, ');
  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts', voice: 'onyx', input: lines, response_format: 'mp3',
      instructions: 'You are an exuberant 1970s television game-show announcer. Project clearly, build excitement, and pause briefly after each family name and player name. Do not imitate any real person.'
    })
  });
  if (!response.ok) throw new Error(`OpenAI speech ${response.status}: ${await response.text()}`);
  return Buffer.from(await response.arrayBuffer());
}

async function createHostSpeech(input) {
  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts', voice: 'onyx', input, response_format: 'mp3',
      instructions: 'Act as a warm, quick-witted 1970s television game-show host. Speak energetically and naturally, with crisp pacing and short dramatic pauses around survey reveals. When the script contains numbered Fast Money questions, read them especially quickly with only a very short pause between questions. Do not imitate any real person and do not add words that are not in the script.'
    })
  });
  if (!response.ok) throw new Error(`OpenAI speech ${response.status}: ${await response.text()}`);
  return Buffer.from(await response.arrayBuffer());
}

setInterval(() => {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  for (const room of rooms.values()) if (room.createdAt < cutoff) disposeRoom(room);
}, 30 * 60 * 1000).unref();

const port = process.env.PORT || 3000;
if (require.main === module) server.listen(port, () => console.log(`Family Feud running on http://localhost:${port}`));
module.exports = { server, io, rooms, makeRoom, beginRound, publicRoom, finishHostedCue, openAnswer, resolveAnswer, awardRound, beginFastMoney, startFastPlayer, finishFastPlayer, disposeRoom };
