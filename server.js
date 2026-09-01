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
    fastPlayers: [], fastAnswers: [null, null], fastScores: [null, null], fastMatches: [null, null], fastSelectorId: null, fastRevealIndex: null, fastPrize: null,
    speechCues: new Map(), cueCounter: 0, createdAt: Date.now()
  };
  rooms.set(code, room); return room;
}

function publicRoom(room) {
  const { announcementAudio, speechCues, fastMatches, ...safeRoom } = room;
  return {
    ...safeRoom,
    players: room.players.map(({ familyName, ...p }) => p),
    game: room.game && room.phase !== 'lobby' && room.phase !== 'generating' ? {
      rounds: [...room.game.rounds, room.game.suddenDeath].map((r, i) => ({ question: r.question, answers: r.answers.map((a, ai) => ({ text: room.revealed.includes(ai) && i === room.round ? a.text : null, points: room.revealed.includes(ai) && i === room.round ? a.points : null })) })),
      fastMoney: room.game.fastMoney.map(q => ({ question: q.question }))
    } : null,
    fastAnswers: room.fastAnswers.map((answers, i) => canRevealFast(room, i) ? answers : answers ? answers.map(() => '••••') : null),
    fastScores: room.fastScores.map((scores, i) => canRevealFast(room, i) ? scores : null),
    fastTopAnswers: room.game && (room.phase === 'fast_results' || (room.phase === 'fast_reveal' && room.fastRevealIndex === 1)) ? room.game.fastMoney.map(q => q.answers[0].text) : null
  };
}

function emit(room) { io.to(room.code).emit('state', publicRoom(room)); }
function player(room, id) { return room.players.find(p => p.id === id); }
function familyOf(room, id) { return room.families.findIndex(f => f.playerIds.includes(id)); }
function familyPlayers(room, fi) { return room.families[fi]?.playerIds.map(id => player(room, id)).filter(Boolean) || []; }
function boardFor(room, index = room.round) { return index === 4 ? room.game.suddenDeath : room.game.rounds[index]; }
function canRevealFast(room, index) { return room.phase === 'fast_results' || (room.phase === 'fast_reveal' && index <= room.fastRevealIndex); }
function emitCue(room, text, sound, speak = true) {
  const cueId = ++room.cueCounter;
  if (speak) {
    room.speechCues.set(cueId, { text, audioPromise: null });
    while (room.speechCues.size > 80) room.speechCues.delete(room.speechCues.keys().next().value);
  }
  io.to(room.code).emit('cue', { text, sound, speechUrl: speak ? `/api/room/${room.code}/speech/${cueId}` : null });
}
function setMessage(room, text, sound, speak = true) { room.message = text; emitCue(room, text, sound, speak); }

io.on('connection', socket => {
  socket.on('createRoom', ({ mode = 'host' } = {}, reply) => {
    const room = makeRoom(mode === 'remote' ? 'remote' : 'host');
    socket.join(room.code); socket.data.roomCode = room.code; socket.data.isDisplay = mode === 'host';
    reply?.({ ok: true, code: room.code, mode: room.mode }); emit(room);
  });

  socket.on('watchRoom', ({ code }, reply) => {
    const room = rooms.get(String(code).toUpperCase());
    if (!room) return reply?.({ ok: false, error: 'That game no longer exists.' });
    socket.join(room.code); socket.data.roomCode = room.code; socket.data.isDisplay = true;
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
    room.fastPlayers = room.fastPlayers.map(id => id === oldId ? socket.id : id);
    socket.join(room.code); socket.data.roomCode = room.code; socket.data.playerId = socket.id;
    reply?.({ ok: true, playerId: socket.id, isAdmin: room.adminId === socket.id, mode: room.mode }); emit(room);
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
    if (!room || room.phase !== 'faceoff' || room.faceoff?.buzzedBy || !room.faceoff?.players.includes(socket.id)) return;
    room.faceoff.buzzedBy = socket.id; room.turnPlayerId = socket.id; room.phase = 'answer';
    setMessage(room, `${player(room, socket.id).name} buzzed in!`, 'buzz'); emit(room);
  });

  socket.on('submitAnswer', async ({ code, answer }, reply) => {
    const room = rooms.get(String(code).toUpperCase());
    if (!room || room.phase !== 'answer' || room.turnPlayerId !== socket.id || room.judging) return reply?.({ ok: false, error: room?.judging ? 'OpenAI is already judging that answer.' : 'It is not your turn.' });
    room.judging = true;
    const board = boardFor(room); const given = String(answer || '').trim().slice(0, 80);
    emitCue(room, `${player(room, socket.id).name} says… ${given}.`);
    const match = await judgeAnswer(given, board.answers, room.revealed);
    if (match.index >= 0) {
      room.revealed.push(match.index); room.bank += board.answers[match.index].points * multiplier(room.round);
      io.to(room.code).emit('answerResult', { correct: true, index: match.index, text: board.answers[match.index].text, points: board.answers[match.index].points });
      emitCue(room, `Survey says… ${board.answers[match.index].text}! ${board.answers[match.index].points} people gave that answer.`, 'reveal');
    } else {
      io.to(room.code).emit('answerResult', { correct: false });
      emitCue(room, room.controlFamily === null ? 'That answer is not on the board.' : 'Ohhh! That is a strike.', 'strike');
    }
    room.judging = false;
    if (room.round === 4 && match.index >= 0) awardSuddenDeath(room, familyOf(room, socket.id));
    else handleAnswer(room, socket.id, match.index);
    emit(room); reply?.({ ok: true, correct: match.index >= 0 });
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

  socket.on('submitFastMoney', async ({ code, answers }) => {
    const room = rooms.get(String(code).toUpperCase());
    if (!room || room.phase !== 'fast_play' || room.turnPlayerId !== socket.id || !Array.isArray(answers) || room.judging) return;
    room.judging = true;
    const idx = room.fastIndex; const clean = answers.slice(0, 5).map(x => String(x || '').slice(0, 80));
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
    room.judging = false; room.phase = 'fast_reveal'; room.fastRevealIndex = idx; room.turnPlayerId = null;
    if (idx === 1) { const total = room.fastScores.flat().reduce((a, b) => a + b, 0); room.fastPrize = total >= 200 ? 10000 : total * 5; }
    setMessage(room, `Let’s reveal ${player(room, room.fastPlayers[idx]).name}’s Fast Money answers.`, 'reveal', false);
    emitCue(room, fastRevealScript(room, idx), 'reveal'); emit(room);
  });

  socket.on('continueFastMoney', ({ code }) => {
    const room = rooms.get(String(code).toUpperCase());
    if (!room || room.phase !== 'fast_reveal' || socket.id !== room.fastSelectorId) return;
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
  room.message = `${opening} Listen carefully for the question.`; emitCue(room, room.message, 'round', false);
  emitCue(room, `${opening} We asked 100 people: ${boardFor(room, index).question} ${p0.name} and ${p1.name}, get ready to buzz in!`); emit(room);
}

function handleAnswer(room, playerId, answerIndex) {
  if (room.faceoff && room.controlFamily === null) return handleFaceoffAnswer(room, playerId, answerIndex);
  if (room.phase !== 'answer') return;
  if (room.isSteal) return awardRound(room, answerIndex >= 0 ? room.controlFamily : 1 - room.controlFamily);
  if (answerIndex < 0) room.strikes++;
  if (room.revealed.length === boardFor(room).answers.length) return awardRound(room, room.controlFamily);
  if (room.strikes >= 3) {
    room.phase = 'answer'; room.controlFamily = 1 - room.controlFamily;
    room.turnPlayerId = familyPlayers(room, room.controlFamily)[0].id;
    room.isSteal = true; setMessage(room, `${room.families[room.controlFamily].name} family can steal!`, 'strike'); return;
  }
  advanceTurn(room);
}

function handleFaceoffAnswer(room, playerId, answerIndex) {
  room.faceoff.attempts.push({ playerId, answerIndex });
  const other = room.faceoff.players.find(id => id !== playerId);
  if (room.faceoff.attempts.length === 1 && answerIndex !== 0) {
    room.turnPlayerId = other; room.phase = 'answer';
    setMessage(room, `${player(room, other).name}, give an answer.`, answerIndex < 0 ? 'strike' : 'reveal'); return;
  }
  const attempts = room.faceoff.attempts.filter(x => x.answerIndex >= 0).sort((a, b) => a.answerIndex - b.answerIndex);
  if (!attempts.length && room.faceoff.attempts.length < 2) { room.turnPlayerId = other; return; }
  if (!attempts.length) {
    room.faceoff.attempts = []; room.faceoff.buzzedBy = null; room.turnPlayerId = null; room.phase = 'faceoff';
    setMessage(room, 'Neither answer made the survey. Buzz in and try again!', 'strike'); return;
  }
  const winner = attempts[0];
  room.faceoff.winnerFamily = familyOf(room, winner.playerId);
  room.turnPlayerId = winner.playerId; room.phase = 'decision';
  setMessage(room, `${room.families[room.faceoff.winnerFamily].name} family: play or pass?`, 'reveal');
}

function startFamilyTurn(room) {
  room.phase = 'answer'; room.strikes = 0; room.isSteal = false;
  const members = familyPlayers(room, room.controlFamily);
  const face = room.faceoff.players.find(id => familyOf(room, id) === room.controlFamily);
  const index = Math.max(0, members.findIndex(p => p.id === face));
  room.turnPlayerId = members[(index + 1) % members.length].id;
  setMessage(room, `${room.families[room.controlFamily].name} family is playing. ${player(room, room.turnPlayerId).name}, your answer!`); emit(room);
}

function advanceTurn(room) {
  const members = familyPlayers(room, room.controlFamily); const index = members.findIndex(p => p.id === room.turnPlayerId);
  room.turnPlayerId = members[(index + 1) % members.length].id;
  setMessage(room, `${player(room, room.turnPlayerId).name}, your answer!`);
}

function awardRound(room, familyIndex) {
  room.scores[familyIndex] += room.bank; room.phase = 'round_end'; room.turnPlayerId = null; room.isSteal = false;
  const remaining = boardFor(room).answers.filter((_, i) => !room.revealed.includes(i)).map(a => a.text);
  room.revealed = boardFor(room).answers.map((_, i) => i);
  setMessage(room, `${room.families[familyIndex].name} family wins ${room.bank} points!${remaining.length ? ` The answers left on the board were ${remaining.join(', ')}.` : ''}`, 'win');
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
  room.scores[familyIndex] += points; room.winnerFamily = familyIndex; room.phase = 'round_end'; room.turnPlayerId = null;
  room.revealed = [0];
  setMessage(room, `${room.families[familyIndex].name} family wins Sudden Death and the game with ${points} points!`, 'win');
}

function startFastPlayer(room, index) {
  room.phase = 'fast_play'; room.fastIndex = index; room.fastRevealIndex = null; room.fastStartedAt = Date.now(); room.turnPlayerId = room.fastPlayers[index];
  const seconds = index === 0 ? 45 : 60; const name = player(room, room.turnPlayerId).name;
  setMessage(room, `${name}: ${seconds} seconds. Good luck!`, 'fast', false);
  const questions = room.game.fastMoney.map((q, i) => `Question ${i + 1}. ${q.question}`).join(' ');
  emitCue(room, `${name}, you have ${seconds} seconds. ${questions}`, 'fast'); emit(room);
}

function fastRevealScript(room, index) {
  const name = player(room, room.fastPlayers[index]).name;
  return room.game.fastMoney.map((q, i) => {
    const guess = room.fastAnswers[index][i] || 'no answer'; const points = room.fastScores[index][i] || 0;
    const top = index === 1 ? ` The number one answer was ${q.answers[0].text}.` : '';
    return `Question ${i + 1}. ${q.question} ${name} said ${guess}. That scored ${points} points.${top}`;
  }).join(' ');
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
