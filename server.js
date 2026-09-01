const path = require('node:path');
const http = require('node:http');
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
    res.type('audio/mpeg').send(await cue.audioPromise);
  } catch (error) {
    console.error('AI host speech unavailable:', error.message);
    res.status(204).end();
  }
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
    speechCues: new Map(), cueCounter: 0, pendingCue: null, displayId: null, createdAt: Date.now()
  };
  rooms.set(code, room); return room;
}

function publicRoom(room) {
  const { announcementAudio, speechCues, fastMatches, pendingCue, fastDraftAnswers, displayId, ...safeRoom } = room;
  return {
    ...safeRoom,
    players: room.players.map(({ familyName, ...p }) => p),
    game: room.game && room.phase !== 'lobby' && room.phase !== 'generating' ? {
      rounds: [...room.game.rounds, room.game.suddenDeath].map((r, i) => ({ question: r.question, answers: r.answers.map((a, ai) => ({ text: room.revealed.includes(ai) && i === room.round ? a.text : null, points: room.revealed.includes(ai) && i === room.round ? a.points : null })) })),
      fastMoney: room.game.fastMoney.map(q => ({ question: q.question }))
    } : null,
    fastAnswers: room.fastAnswers.map((answers, i) => canRevealFast(room, i) ? answers : answers ? answers.map(() => '••••') : null),
    fastScores: room.fastScores.map((scores, i) => canRevealFast(room, i) ? scores : null),
    fastTopAnswers: room.game && (room.phase === 'fast_results' || ((room.phase === 'fast_reveal' || room.phase === 'fast_reveal_done') && room.fastRevealIndex === 1)) ? room.game.fastMoney.map(q => q.answers[0].text) : null
  };
}

function emit(room) { io.to(room.code).emit('state', publicRoom(room)); }
function player(room, id) { return room.players.find(p => p.id === id); }
function familyOf(room, id) { return room.families.findIndex(f => f.playerIds.includes(id)); }
function familyPlayers(room, fi) { return room.families[fi]?.playerIds.map(id => player(room, id)).filter(Boolean) || []; }
function boardFor(room, index = room.round) { return index === 4 ? room.game.suddenDeath : room.game.rounds[index]; }
function canRevealFast(room, index) { return room.phase === 'fast_results' || ((room.phase === 'fast_reveal' || room.phase === 'fast_reveal_done') && index <= room.fastRevealIndex); }
function emitCue(room, text, sound, speak = true, requiresAck = false) {
  const cueId = ++room.cueCounter;
  if (speak) {
    room.speechCues.set(cueId, { text, audioPromise: null });
    while (room.speechCues.size > 80) room.speechCues.delete(room.speechCues.keys().next().value);
  }
  io.to(room.code).emit('cue', { cueId, text, sound, requiresAck, speechUrl: speak ? `/api/room/${room.code}/speech/${cueId}` : null });
  return cueId;
}
function setMessage(room, text, sound, speak = true) { room.message = text; emitCue(room, text, sound, speak); }

function runHostedCue(room, text, sound, onComplete) {
  room.inputLocked = true;
  const cueId = emitCue(room, text, sound, true, true);
  const timeout = setTimeout(() => finishHostedCue(room, cueId), Math.min(60000, Math.max(15000, text.split(/\s+/).length * 650)));
  room.pendingCue = { cueId, onComplete, timeout };
  emit(room);
}

function finishHostedCue(room, cueId) {
  if (!room.pendingCue || room.pendingCue.cueId !== cueId) return;
  clearTimeout(room.pendingCue.timeout);
  const complete = room.pendingCue.onComplete;
  room.pendingCue = null;
  complete?.();
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

  socket.on('joinRoom', ({ code, name, familyName, photo }, reply) => {
    const room = rooms.get(String(code).toUpperCase());
    if (!room || room.phase !== 'lobby') return reply?.({ ok: false, error: 'That lobby is unavailable.' });
    if (room.players.length >= 10) return reply?.({ ok: false, error: 'This game is full. Family Feud supports a maximum of 10 players.' });
    if (!name?.trim() || !familyName?.trim() || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photo || '')) return reply?.({ ok: false, error: 'Name, photo, and family name are required.' });
    if (photo.length > 1_500_000) return reply?.({ ok: false, error: 'Please use a smaller photo.' });
    const p = { id: socket.id, name: name.trim().slice(0, 24), familyName: familyName.trim().replace(/\s+family$/i, '').slice(0, 24), photo, connected: true };
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

  socket.on('startGame', async ({ code }, reply) => {
    const room = rooms.get(String(code).toUpperCase());
    if (!room || socket.id !== room.adminId || room.phase !== 'lobby') return reply?.({ ok: false, error: 'Only the first player can start.' });
    if (room.players.length < 2) return reply?.({ ok: false, error: 'At least two players are needed.' });
    room.phase = 'generating'; setMessage(room, 'OpenAI is preparing tonight’s surveys…', null, false); emit(room); reply?.({ ok: true });
    room.game = await generateGamePackage();
    const shuffled = [...room.players].sort(() => Math.random() - .5);
    const ids = [[], []]; shuffled.forEach((p, i) => ids[i % 2].push(p.id));
    room.families = ids.map((playerIds, fi) => {
      const suggestions = playerIds.map(id => player(room, id).familyName).filter(Boolean);
      return { name: suggestions[Math.floor(Math.random() * suggestions.length)] || `Family ${fi + 1}`, playerIds };
    });
    room.phase = 'intro'; room.introStartedAt = Date.now(); setMessage(room, 'It’s time for the Family Feud!', null, false); emit(room);
  });

  socket.on('introComplete', ({ code }) => {
    const room = rooms.get(String(code).toUpperCase());
    if (!room || (socket.id !== room.adminId && !socket.data.isDisplay) || room.phase !== 'intro') return;
    beginRound(room, 0);
  });

  socket.on('buzz', ({ code }) => {
    const room = rooms.get(String(code).toUpperCase());
    if (!room || room.phase !== 'faceoff' || room.inputLocked || room.faceoff?.buzzedBy || !room.faceoff?.players.includes(socket.id)) return;
    room.faceoff.buzzedBy = socket.id; room.turnPlayerId = socket.id; room.phase = 'answer';
    room.inputLocked = false; room.message = `${player(room, socket.id).name} buzzed in! Give your answer.`;
    emitCue(room, room.message, 'buzz', false); emit(room);
  });

  socket.on('submitAnswer', async ({ code, answer }, reply) => {
    const room = rooms.get(String(code).toUpperCase());
    if (!room || room.phase !== 'answer' || room.turnPlayerId !== socket.id || room.judging || room.inputLocked) return reply?.({ ok: false, error: room?.judging || room?.inputLocked ? 'Please wait for the host to finish.' : 'It is not your turn.' });
    room.judging = true; room.inputLocked = true; emit(room);
    const board = boardFor(room); const given = String(answer || '').trim().slice(0, 80);
    const match = await judgeAnswer(given, board.answers, room.revealed);
    let resultText; let resultSound;
    if (match.index >= 0) {
      room.revealed.push(match.index); room.bank += board.answers[match.index].points * multiplier(room.round);
      io.to(room.code).emit('answerResult', { correct: true, index: match.index, text: board.answers[match.index].text, points: board.answers[match.index].points });
      resultText = `The question was: ${board.question} ${player(room, socket.id).name} said ${given}. Survey says… ${board.answers[match.index].text}! ${board.answers[match.index].points} people gave that answer.`;
      resultSound = 'reveal';
    } else {
      io.to(room.code).emit('answerResult', { correct: false });
      resultText = `The question was: ${board.question} ${player(room, socket.id).name} said ${given}. ${room.controlFamily === null ? 'That answer is not on the board.' : 'Ohhh! That is a strike.'}`;
      resultSound = 'strike';
    }
    reply?.({ ok: true, correct: match.index >= 0 });
    runHostedCue(room, resultText, resultSound, () => {
      room.judging = false; room.inputLocked = false;
      if (room.round === 4 && match.index >= 0) awardSuddenDeath(room, familyOf(room, socket.id));
      else handleAnswer(room, socket.id, match.index);
      emit(room);
    });
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

  socket.on('submitFastAnswer', ({ code, answer }) => {
    const room = rooms.get(String(code).toUpperCase());
    if (!room || room.phase !== 'fast_play' || room.turnPlayerId !== socket.id || room.judging || room.inputLocked) return;
    room.fastDraftAnswers[room.fastQuestionIndex] = String(answer || '').trim().slice(0, 80);
    if (room.fastQuestionIndex >= 4) return finishFastPlayer(room);
    room.fastQuestionIndex++;
    askFastQuestion(room);
  });

  socket.on('fastTimeout', ({ code }) => {
    const room = rooms.get(String(code).toUpperCase());
    if (!room || room.phase !== 'fast_play' || room.turnPlayerId !== socket.id || room.judging) return;
    while (room.fastDraftAnswers.length < 5) room.fastDraftAnswers.push('');
    finishFastPlayer(room);
  });

  async function finishFastPlayer(room) {
    if (room.judging || room.phase !== 'fast_play') return;
    room.judging = true; room.inputLocked = true; emit(room);
    const idx = room.fastIndex; const clean = Array.from({ length: 5 }, (_, i) => String(room.fastDraftAnswers[i] || '').slice(0, 80));
    room.fastAnswers[idx] = clean;
    const judgments = await Promise.all(clean.map((guess, qi) => judgeAnswer(guess, room.game.fastMoney[qi].answers)));
    room.fastMatches[idx] = judgments.map(judgment => judgment.index);
    room.fastScores[idx] = clean.map((guess, qi) => {
      const candidates = room.game.fastMoney[qi].answers;
      const m = judgments[qi];
      if (idx === 1 && room.fastAnswers[0]) {
        const firstIndex = room.fastMatches[0]?.[qi] ?? matchAnswer(room.fastAnswers[0][qi], candidates).index;
        if ((m.index >= 0 && m.index === firstIndex) || normalizeLoose(guess) === normalizeLoose(room.fastAnswers[0][qi])) return 0;
      }
      return m.index >= 0 ? candidates[m.index].points : 0;
    });
    room.judging = false; room.turnPlayerId = null;
    if (idx === 1) { const total = room.fastScores.flat().reduce((a, b) => a + b, 0); room.fastPrize = total >= 200 ? 10000 : total * 5; }
    startFastReveal(room, idx);
  }

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
  room.round = index; room.revealed = []; room.strikes = 0; room.bank = 0; room.controlFamily = null;
  const p0 = familyPlayers(room, 0)[index % familyPlayers(room, 0).length];
  const p1 = familyPlayers(room, 1)[index % familyPlayers(room, 1).length];
  room.faceoff = { players: [p0.id, p1.id], buzzedBy: null, attempts: [], winnerFamily: null };
  room.phase = 'faceoff'; room.turnPlayerId = null;
  const opening = index === 4 ? 'Sudden Death.' : `Round ${index + 1}.`;
  room.message = `${opening} The host is calling the faceoff players.`;
  runHostedCue(room, `${opening} Let's have ${p0.name}. Let's have ${p1.name}. We asked 100 people: ${boardFor(room, index).question}`, 'round', () => {
    room.inputLocked = false; room.message = 'Buzz now!'; emit(room);
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
    return promptForAnswer(room, other, `${player(room, other).name}, give an answer.`, answerIndex < 0 ? 'strike' : 'reveal');
  }
  const attempts = room.faceoff.attempts.filter(x => x.answerIndex >= 0).sort((a, b) => a.answerIndex - b.answerIndex);
  if (!attempts.length && room.faceoff.attempts.length < 2) { room.turnPlayerId = other; return; }
  if (!attempts.length) {
    room.faceoff.attempts = []; room.faceoff.buzzedBy = null; room.turnPlayerId = null; room.phase = 'faceoff';
    return runHostedCue(room, 'Neither answer made the survey. Listen to the question again, then buzz in. ' + boardFor(room).question, 'strike', () => {
      room.inputLocked = false; room.message = 'Buzz now!'; emit(room);
    });
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
    room.phase = 'answer'; room.inputLocked = false; emit(room);
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
  room.revealed.push(index); room.message = `${answer.text} — ${answer.points}`;
  runHostedCue(room, `Number ${index + 1}. ${answer.text}. ${answer.points} people gave that answer.`, 'reveal', () => revealRemainingAnswer(room, remaining));
}

function beginFastMoney(room) {
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
  room.phase = 'host_wait'; room.fastIndex = index; room.fastRevealIndex = null; room.fastRevealCount = 0; room.fastQuestionIndex = 0; room.fastDraftAnswers = []; room.fastDeadline = null; room.turnPlayerId = room.fastPlayers[index];
  const seconds = index === 0 ? 45 : 60; const name = player(room, room.turnPlayerId).name;
  room.message = `${name} is getting ready for Fast Money.`;
  runHostedCue(room, `${name}, you have ${seconds} seconds. Listen carefully and answer each question as quickly as you can.`, 'fast', () => {
    room.phase = 'fast_play'; room.fastDeadline = Date.now() + seconds * 1000; askFastQuestion(room);
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

function revealNextFastAnswer(room) {
  if (room.fastRevealCount >= 5) {
    room.phase = 'fast_reveal_done'; room.inputLocked = false;
    room.message = `${player(room, room.fastPlayers[room.fastRevealIndex]).name}'s reveal is complete.`; emit(room); return;
  }
  const i = room.fastRevealCount++; const idx = room.fastRevealIndex; const q = room.game.fastMoney[i];
  const guess = room.fastAnswers[idx][i] || 'no answer'; const points = room.fastScores[idx][i] || 0;
  const top = idx === 1 ? ` The number one answer was ${q.answers[0].text}.` : '';
  room.message = `${guess} — ${points} points`;
  runHostedCue(room, `Question ${i + 1}. ${q.question} ${player(room, room.fastPlayers[idx]).name} said ${guess}. That scored ${points} points.${top}`, 'reveal', () => revealNextFastAnswer(room));
}

function multiplier(round) { return round < 2 ? 1 : round === 2 ? 2 : 3; }
function normalizeLoose(v) { return String(v || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

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
    method: 'POST',
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
  for (const [code, room] of rooms) if (room.createdAt < cutoff) rooms.delete(code);
}, 30 * 60 * 1000).unref();

const port = process.env.PORT || 3000;
server.listen(port, () => console.log(`Family Feud running on http://localhost:${port}`));
