const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs/promises');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { BUILTIN_GAME, judgeAnswer, matchAnswer, newCode } = require('./src/game');
const { SurveyBank } = require('./src/survey-bank');
const surveyBank = new SurveyBank();
const { ERAS, chooseEra } = require('./src/eras');
function refillSurveys(){
  if(!process.env.OPENAI_API_KEY)return;
  try {void surveyBank.refill().catch(error=>console.error('Survey bank:',error.message));}
  catch(error){console.error('Survey bank:',error.message);}
}

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
    const family = Number(req.query.family), part = req.query.part;
    if (part !== 'host' && (![0, 1].includes(family) || !['name', 'members'].includes(part))) return res.status(400).end();
    room.announcementAudio ||= new Map();
    const key = `${family}-${part}`;
    if (!room.announcementAudio.has(key)) room.announcementAudio.set(key, createAnnouncement(room, family, part));
    res.type('audio/mpeg').send(await room.announcementAudio.get(key));
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
    if (!cue.audioPromise) cue.audioPromise = createHostSpeech(cue.text, room.era);
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

function fallbackEndCredits(era = 'dawson') {
  const host = ERAS[era]?.name || ERAS.dawson.name;
  return [
    { role: 'EXECUTIVE PRODUCER', name: 'Patty O’Furniture' },
    { role: 'PRODUCED BY', name: 'Drew Peacock' },
    { role: 'CO-PRODUCER', name: 'Anita Goodanswer' },
    { role: `${host.toUpperCase()}'S WARDROBE PROVIDED BY`, name: 'Lapels & Leisure Ltd.' },
    { role: 'CONTESTANT FLIGHTS PROVIDED BY', name: 'Good Answer Airways' },
    { role: 'SET DESIGN', name: 'Survey Says Scenic Co.' },
    { role: 'BUZZER MAINTENANCE', name: 'Two Short Buzzes Inc.' },
    { role: 'CATERING', name: 'Name a Sandwich Studios' }
  ];
}

async function generateEndCredits(room) {
  if (!process.env.OPENAI_API_KEY) return null;
  const host = ERAS[room.era || 'dawson'].name;
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST', signal: AbortSignal.timeout(12000),
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-5-mini',
      instructions: 'Create short, family-friendly joke credits for a private Family Feud-style game. Invent fictional names and fictional businesses only. Use gentle wordplay, never real people, real brands, insults, adult jokes, or copyrighted character names. Each value must be 32 characters or fewer.',
      input: JSON.stringify({ host, families: room.families.map(f => f.name), contestants: room.players.map(p => p.name) }),
      text: { format: { type: 'json_schema', name: 'end_credits', strict: true, schema: {
        type: 'object', additionalProperties: false,
        properties: {
          executiveProducer: { type: 'string' }, producer: { type: 'string' }, coProducer: { type: 'string' },
          wardrobeCompany: { type: 'string' }, airline: { type: 'string' }, setDesigner: { type: 'string' },
          buzzerCompany: { type: 'string' }, caterer: { type: 'string' }
        },
        required: ['executiveProducer', 'producer', 'coProducer', 'wardrobeCompany', 'airline', 'setDesigner', 'buzzerCompany', 'caterer']
      } } }
    })
  });
  if (!response.ok) throw new Error(`OpenAI credits ${response.status}: ${await response.text()}`);
  const payload = await response.json();
  const output = payload.output_text || payload.output?.flatMap(item => item.content || []).find(item => item.type === 'output_text')?.text;
  const names = JSON.parse(output);
  if (Object.values(names).some(name => typeof name !== 'string' || !name.trim() || name.length > 40)) throw new Error('Invalid generated credits');
  return [
    { role: 'EXECUTIVE PRODUCER', name: names.executiveProducer },
    { role: 'PRODUCED BY', name: names.producer },
    { role: 'CO-PRODUCER', name: names.coProducer },
    { role: `${host.toUpperCase()}'S WARDROBE PROVIDED BY`, name: names.wardrobeCompany },
    { role: 'CONTESTANT FLIGHTS PROVIDED BY', name: names.airline },
    { role: 'SET DESIGN', name: names.setDesigner },
    { role: 'BUZZER MAINTENANCE', name: names.buzzerCompany },
    { role: 'CATERING', name: names.caterer }
  ];
}

function prepareEndCredits(room) {
  room.creditsPromise ||= generateEndCredits(room).then(credits => {
    if (credits) room.endCredits = credits;
    return room.endCredits;
  }).catch(error => {
    console.error('AI end credits unavailable:', error.message);
    return room.endCredits;
  });
  return room.creditsPromise;
}

function makeRoom(mode, era = chooseEra()) {
  let code; do code = newCode(); while (rooms.has(code));
  const room = {
    code, mode, era, phase: 'lobby', adminId: null, players: [], families: [], scores: [0, 0],
    game: null, round: -1, revealed: [], strikes: 0, bank: 0, faceoff: null,
    controlFamily: null, turnPlayerId: null, message: 'Waiting for players', winnerFamily: null,
    fastPlayers: [], fastAnswers: [null, null], fastScores: [null, null], fastMatches: [null, null], fastSelectorId: null, fastRevealIndex: null, fastRevealCount: 0, fastWinningRevealCount: null, fastPrize: null,
    fastQuestionIndex: null, fastDraftAnswers: [], fastDeadline: null, inputLocked: false,
    answerDeadline: null, answerTimer: null, answerToken: 0, fastTimer: null,
    kissPlayerId: null, kissStatus: 'off', kissImage: null,
    endCredits: fallbackEndCredits(era), creditsPromise: null,
    speechCues: new Map(), cueCounter: 0, pendingCue: null, displayId: null, createdAt: Date.now()
  };
  rooms.set(code, room); return room;
}

function publicRoom(room) {
  const { announcementAudio, speechCues, fastSpeech, fastMatches, pendingCue, fastDraftAnswers, fastDraftMatches, fastPendingAnswer, fastQuestionQueue, fastQuestionAttempts, displayId, answerTimer, fastTimer, transitionTimer, kissImage, creditsPromise, ...safeRoom } = room;
  return {
    ...safeRoom,
    serverNow: Date.now(),
    pendingSpeech: pendingCue ? { cueId: pendingCue.cueId, text: speechCues.get(pendingCue.cueId)?.text, sound: speechCues.get(pendingCue.cueId)?.sound, speechUrl: `/api/room/${room.code}/speech/${pendingCue.cueId}`, requiresAck: true } : null,
    players: room.players.map(({ familyName, kissConsent, ...p }) => p),
    game: room.game && room.phase !== 'lobby' && room.phase !== 'generating' ? {
      rounds: [...room.game.rounds, room.game.suddenDeath].map((r, i) => ({ answers: r.answers.map((a, ai) => ({ text: room.revealed.includes(ai) && i === room.round ? a.text : null, points: room.revealed.includes(ai) && i === room.round ? a.points : null })) })),
      fastMoney: room.game.fastMoney.map((q, i) => ({ question: canRevealFast(room, room.fastRevealIndex ?? 0, i, 'question') ? q.question : null }))
    } : null,
    fastAnswers: room.fastAnswers.map((answers, i) => answers?.map((answer, qi) => canRevealFast(room, i, qi, 'answer') ? answer : null) ?? null),
    fastScores: room.fastScores.map((scores, i) => scores?.map((score, qi) => canRevealFast(room, i, qi) ? score : null) ?? null),
    fastFirstTotal: room.fastIndex === 1 ? (room.fastScores[0] || []).reduce((sum, points) => sum + (Number(points) || 0), 0) : null,
    fastTopAnswers: room.game ? room.game.fastMoney.map((q, qi) => canRevealFast(room, 1, qi) ? q.answers[0].text : null) : null
  };
}

function emit(room) { io.to(room.code).emit('state', publicRoom(room)); }
function player(room, id) { return room.players.find(p => p.id === id); }
// Only the owner of an explicitly created rehearsal can play the sample contestants.
function testController(room, socketId) { return !!room?.testPart && room.adminId === socketId; }
function answeringPlayer(room, socketId) { return testController(room, socketId) ? room.turnPlayerId : socketId; }
function samplePhoto(index) {
  const colors = ['#456c91', '#875333', '#4a7867', '#895768'];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240"><rect width="240" height="240" fill="${colors[index]}"/><circle cx="120" cy="86" r="43" fill="#e9d7ab"/><path d="M35 240v-30a85 85 0 0 1 170 0v30" fill="#e9d7ab"/><text x="120" y="225" text-anchor="middle" font-family="sans-serif" font-size="20" fill="#342917">SAMPLE ${index + 1}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}
function familyOf(room, id) { return room.families.findIndex(f => f.playerIds.includes(id)); }
function familyPlayers(room, fi) { return room.families[fi]?.playerIds.map(id => player(room, id)).filter(Boolean) || []; }
function boardFor(room, index = room.round) { return index === 4 ? room.game.suddenDeath : room.game.rounds[index]; }
function canRevealFast(room, index, questionIndex = 0, part = 'points') {
  if (room.phase === 'fast_results') return index === 0 || room.fastWinningRevealCount == null || questionIndex < room.fastWinningRevealCount;
  if (!['fast_reveal', 'fast_reveal_done'].includes(room.phase)) return false;
  if (index < room.fastRevealIndex) return true;
  if (index !== room.fastRevealIndex) return false;
  if (questionIndex < room.fastRevealCount) return true;
  if (questionIndex !== room.fastRevealCount) return false;
  return (part === 'question' && ['question', 'answer_pending', 'answer', 'survey'].includes(room.fastRevealStep)) || (part === 'answer' && ['answer', 'survey'].includes(room.fastRevealStep));
}
function emitCue(room, text, sound, speak = true, requiresAck = false) {
  const cueId = ++room.cueCounter;
  if (speak) {
    room.speechCues.set(cueId, { text, sound, audioPromise: room.fastSpeech?.get(text) || null });
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
  clearTimeout(room.answerTimer); room.answerTimer = null; room.answerDeadline = null; room.stealWarning = false;
}

function openAnswer(room, playerId) {
  clearAnswerClock(room);
  room.phase = 'answer'; room.turnPlayerId = playerId; room.inputLocked = false;
  const token = ++room.answerToken;
  room.goodAnswerPlayers = [];
  const duration = room.isSteal ? 30000 : 15000;
  room.answerDeadline = Date.now() + duration;
  room.answerTimer = setTimeout(() => answerClockExpired(room, token), duration);
  emit(room);
}

function answerClockExpired(room, token) {
  if (room.phase !== 'answer' || room.answerToken !== token || room.judging) return;
  clearTimeout(room.answerTimer);
  if (!room.isSteal || room.stealWarning) return void resolveAnswer(room, player(room, room.turnPlayerId), '', true);
  room.answerTimer = null; room.answerDeadline = null; room.stealWarning = true;
  room.message = 'I need an answer!';
  runHostedCue(room, room.message, null, () => {
    if (room.phase !== 'answer' || room.answerToken !== token || room.judging) return;
    room.answerDeadline = Date.now() + 3000;
    room.answerTimer = setTimeout(() => answerClockExpired(room, token), 3000);
    room.inputLocked = false; emit(room);
  });
  // A family can submit while the host asks for its answer.
  room.inputLocked = false; emit(room);
}

function revealSlot(room, index) {
  if (!room.revealed.includes(index)) room.revealed.push(index);
  emit(room);
  io.to(room.code).emit('boardReveal', { round: room.round, index });
}

async function resolveAnswer(room, contestant, given, timedOut = false) {
  if (room.judging || room.phase !== 'answer') return;
  cancelHostedCue(room);
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
      if (room.controlFamily === null && room.faceoff) room.faceoff.showBoard = true;
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
  socket.on('createTestRoom', async ({ part, name, photo, kissConsent = false, era = 'dawson' } = {}, reply) => {
    if (!['dawson','harvey','random'].includes(era)) return reply?.({ ok: false, error: 'Choose an available era.' });
    if (!['intro', 'fast'].includes(part)) return reply?.({ ok: false, error: 'Choose an introduction or Fast Money test.' });
    if (photo && (typeof photo !== 'string' || photo.length > 1_500_000 || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photo))) return reply?.({ ok: false, error: 'Please use a smaller JPG, PNG, or WebP photo.' });
    if (kissConsent && !photo) return reply?.({ ok: false, error: 'Upload your own photo to test the optional souvenir.' });
    const existing = rooms.get(socket.data.roomCode);
    if (existing) return reply?.({ ok: false, error: 'Exit your current game before starting a test.' });
    const room = makeRoom('remote', era === 'random' ? chooseEra() : era);
    room.testPart = part; room.adminId = socket.id; room.phase = 'generating';
    room.game = structuredClone(BUILTIN_GAME); // Repeatable, isolated fixtures; no survey-generation charge.
    room.players = [String(name || '').trim().slice(0, 24) || 'Alex', 'Sam', 'Taylor', 'Jordan'].map((name, i) => ({
      id: i === 0 ? socket.id : `sample-${room.code}-${i}`, name, photo: i === 0 && photo ? photo : samplePhoto(i),
      familyName: i < 2 ? 'Sunshine' : 'Moonlight', connected: true, sample: i !== 0,
      kissConsent: i === 0 && part === 'intro' && kissConsent === true
    }));
    room.families = ['Sunshine', 'Moonlight'].map((name, i) => ({ name, playerIds: room.players.slice(i * 2, i * 2 + 2).map(p => p.id) }));
    socket.join(room.code); socket.data.roomCode = room.code; socket.data.playerId = socket.id; socket.data.isDisplay = false;
    reply?.({ ok: true, code: room.code, playerId: socket.id });
    room.message = 'Preparing your test…'; emit(room);
    if (part === 'fast') {
      room.scores = [350, 180]; room.winnerFamily = 0; beginFastMoney(room);
    } else {
      await prepareKissImage(room);
      room.phase = 'intro'; room.introStartedAt = Date.now(); room.message = 'Introduction and Round 1 rehearsal'; emit(room);
    }
  });

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
    if (!p || p.sample) return reply?.({ ok: false });
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
    room.phase = 'generating';
    try { room.game = surveyBank.take(); }
    catch(error){room.phase='lobby';refillSurveys();emit(room);return reply?.({ok:false,error:error.message});}
    reply?.({ ok: true });refillSurveys();
    // The optional souvenir can finish during the intro; it must not hold up play.
    void prepareKissImage(room).then(()=>emit(room));
    // Warm only the five shared Fast Money questions; both contestants reuse them.
    if (process.env.OPENAI_API_KEY) room.fastSpeech = new Map(room.game.fastMoney.map(q => {
      const text = q.question;
      return [text, createHostSpeech(text, room.era).catch(() => null)];
    }));
    const shuffled = [...room.players].sort(() => Math.random() - .5);
    const ids = [[], []]; shuffled.forEach((p, i) => ids[i % 2].push(p.id));
    room.families = ids.map((playerIds, fi) => {
      const suggestions = playerIds.map(id => player(room, id).familyName).filter(Boolean);
      return { name: suggestions[Math.floor(Math.random() * suggestions.length)] || `Family ${fi + 1}`, playerIds };
    });
    void prepareEndCredits(room).then(() => emit(room));
    room.phase = 'intro'; room.introStartedAt = Date.now(); setMessage(room, 'It’s time for the Family Feud!', null, false); emit(room);
  });

  socket.on('introComplete', ({ code }) => {
    const room = rooms.get(String(code).toUpperCase());
    if (room?.testPart && !testController(room, socket.id)) return;
    if (!room || (socket.id !== room.adminId && !socket.data.isDisplay) || room.phase !== 'intro') return;
    beginRound(room, 0);
  });

  socket.on('buzz', ({ code, playerId }) => {
    const room = rooms.get(String(code).toUpperCase());
    const contestantId = testController(room, socket.id) ? playerId : socket.id;
    if (!room || room.phase !== 'faceoff' || !room.faceoff?.canBuzz || room.faceoff.buzzedBy || !room.faceoff.players.includes(contestantId)) return;
    room.faceoff.buzzedBy = contestantId; room.faceoff.canBuzz = false;
    cancelHostedCue(room);
    room.message = `${player(room, contestantId).name} buzzed in! Fifteen seconds.`;
    emitCue(room, room.message, 'buzz', false); openAnswer(room, contestantId);
  });

  socket.on('submitAnswer', ({ code, answer, token }, reply) => {
    const room = rooms.get(String(code).toUpperCase());
    const contestantId = room && answeringPlayer(room, socket.id);
    if (!room || room.phase !== 'answer' || room.turnPlayerId !== contestantId || room.judging || room.inputLocked || token !== room.answerToken) return reply?.({ ok: false, error: 'Please wait for your turn.' });
    if (room.answerDeadline && Date.now() >= room.answerDeadline) {
      answerClockExpired(room, token);
      if (room.judging) return reply?.({ ok: false, error: 'Time is up.' });
    }
    const given = String(answer || '').trim().slice(0, 80);
    if (!given) return reply?.({ ok: false, error: 'Enter an answer.' });
    reply?.({ ok: true }); void resolveAnswer(room, player(room, contestantId), given);
  });

  socket.on('playOrPass', ({ code, choice }) => {
    const room = rooms.get(String(code).toUpperCase());
    if (!room || room.phase !== 'decision' || (!testController(room, socket.id) && familyOf(room, socket.id) !== room.faceoff.winnerFamily)) return;
    room.controlFamily = choice === 'pass' ? 1 - room.faceoff.winnerFamily : room.faceoff.winnerFamily;
    startFamilyTurn(room);
  });

  socket.on('goodAnswer', ({ code }) => {
    const room = rooms.get(String(code).toUpperCase());
    const supporter = room && player(room, socket.id);
    if (!supporter || !supporter.connected || room.phase !== 'answer' || socket.id === room.turnPlayerId || familyOf(room, socket.id) !== familyOf(room, room.turnPlayerId) || room.goodAnswerPlayers?.includes(socket.id)) return;
    (room.goodAnswerPlayers ||= []).push(socket.id);
    io.to(room.code).emit('goodAnswer', { name: supporter.name, family: room.families[familyOf(room, socket.id)].name });
  });

  socket.on('nextRound', ({ code }) => {
    const room = rooms.get(String(code).toUpperCase());
    if (!room || socket.id !== room.adminId || room.phase !== 'round_end') return;
    advanceAfterRound(room);
  });

  socket.on('selectFastPlayers', ({ code, playerIds }) => {
    const room = rooms.get(String(code).toUpperCase());
    if (!room || room.phase !== 'fast_select' || socket.id !== room.fastSelectorId) return;
    const winner = room.winnerFamily ?? (room.scores[0] >= room.scores[1] ? 0 : 1);
    const valid = [...new Set(playerIds)].filter(id => room.families[winner].playerIds.includes(id));
    if (valid.length !== 2) return;
    room.fastPlayers = valid; startFastPlayer(room, 0);
  });

  socket.on('submitFastAnswer', ({ code, answer, questionIndex, fastIndex, attempt = 0 }, reply) => {
    const room = rooms.get(String(code).toUpperCase());
    if (!room || room.phase !== 'fast_play' || room.turnPlayerId !== answeringPlayer(room, socket.id) || room.judging || room.inputLocked || questionIndex !== room.fastQuestionIndex || fastIndex !== room.fastIndex || attempt !== room.fastAttempt) return reply?.({ ok: false });
    if (Date.now() >= room.fastDeadline) { void finishFastPlayer(room); return reply?.({ ok: false }); }
    const given = String(answer || '').trim().slice(0, 80);
    if (!given) return reply?.({ ok: false });
    room.inputLocked = true; emit(room); reply?.({ ok: true });
    void acceptFastAnswer(room, given);
  });

  socket.on('passFastQuestion', ({ code, questionIndex, fastIndex, attempt = 0 }, reply) => {
    const room = rooms.get(String(code).toUpperCase());
    if (!room || room.phase !== 'fast_play' || room.turnPlayerId !== answeringPlayer(room, socket.id) || room.judging || room.inputLocked || questionIndex !== room.fastQuestionIndex || fastIndex !== room.fastIndex || attempt !== room.fastAttempt) return reply?.({ ok: false });
    if (Date.now() >= room.fastDeadline) { void finishFastPlayer(room); return reply?.({ ok: false }); }
    room.inputLocked = true;
    room.fastQuestionAttempts[questionIndex] = room.fastAttempt + 1;
    room.fastQuestionQueue.push(questionIndex);
    reply?.({ ok: true });
    advanceFastQuestion(room);
  });

  socket.on('fastTimeout', ({ code }) => {
    const room = rooms.get(String(code).toUpperCase());
    if (!room || room.phase !== 'fast_play' || room.turnPlayerId !== socket.id || room.judging || !room.fastDeadline || Date.now() < room.fastDeadline) return;
    while (room.fastDraftAnswers.length < 5) room.fastDraftAnswers.push('');
    finishFastPlayer(room);
  });

  socket.on('continueFastMoney', ({ code }) => {
    const room = rooms.get(String(code).toUpperCase());
    if (!room || room.phase !== 'fast_reveal_done' || socket.id !== room.fastSelectorId) return;
    advanceFastReveal(room);
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomCode); const p = room && player(room, socket.id);
    if (p) { p.connected = false; emit(room); }
  });
});

function beginRound(room, index) {
  clearTransition(room);
  clearAnswerClock(room);
  room.round = index; room.revealed = []; room.strikes = 0; room.bank = 0; room.controlFamily = null;
  room.isSteal = false;
  const p0 = familyPlayers(room, 0)[index % familyPlayers(room, 0).length];
  const p1 = familyPlayers(room, 1)[index % familyPlayers(room, 1).length];
  room.faceoff = { players: [p0.id, p1.id], buzzedBy: null, attempts: [], pairStart: 0, winnerFamily: null, canBuzz: false, showBoard: false };
  room.phase = 'faceoff'; room.turnPlayerId = null;
  const opening = index === 4 ? 'Sudden Death.' : `Round ${index + 1}.`;
  room.message = `${opening} The host is calling the faceoff players.`;
  runHostedCue(room, `${opening} Let's have ${p0.name}. Let's have ${p1.name}.`, 'faceoff_walkup', () => readFaceoffQuestion(room));
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
    return promptForAnswer(room, stealer, `${room.families[room.controlFamily].name} family, you can steal. Let me read the question again. ${boardFor(room).question} Shout out some possible answers! ${player(room, stealer).name}, give me your family's answer when you are ready.`);
  }
  if (answerIndex < 0 && room.strikes === 2) {
    room.phase = 'host_wait'; room.message = `${room.families[1 - room.controlFamily].name} family, get ready to steal.`;
    return runHostedCue(room, room.message, null, () => advanceTurn(room));
  }
  advanceTurn(room);
}

function handleFaceoffAnswer(room, playerId, answerIndex) {
  room.faceoff.attempts.push({ playerId, answerIndex });
  room.faceoff.showBoard = false;
  const pairAttempts = room.faceoff.attempts.slice(room.faceoff.pairStart || 0);
  const other = room.faceoff.players.find(id => id !== playerId);
  if (pairAttempts.length === 1 && answerIndex !== 0) {
    return promptForAnswer(room, other, `Let me read ${player(room, other).name} the entire question before they answer. ${boardFor(room).question}`);
  }
  const attempts = pairAttempts.filter(x => x.answerIndex >= 0).sort((a, b) => a.answerIndex - b.answerIndex);
  if (!attempts.length) {
    // Keep the original buzzer priority and walk down BOTH families. Never re-buzz.
    const firstFamily = familyOf(room, room.faceoff.buzzedBy);
    room.faceoff.players = [0, 1].map(fi => {
      const members = familyPlayers(room, fi);
      const current = members.findIndex(p => p.id === room.faceoff.players[fi]);
      return members[(current + 1) % members.length].id;
    });
    room.faceoff.pairStart = room.faceoff.attempts.length; room.faceoff.canBuzz = false;
    const next = room.faceoff.players[firstFamily];
    return promptForAnswer(room, next, `We move to the next family members. ${player(room, next).name}, ${room.families[firstFamily].name} family, your answer.`);
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
  room.phase = 'host_wait'; room.turnPlayerId = playerId;
  // The spoken full-question handoff must not leak into the visible status banner.
  room.message = room.isSteal ? `${room.families[room.controlFamily].name} family, listen to the question, then discuss your steal.` : room.controlFamily === null && room.faceoff ? `${player(room, playerId).name}, listen to the host, then answer.` : text;
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
    if (room.testPart === 'intro') room.message = 'Introduction and Round 1 test complete. You can replay it or test Fast Money.';
    room.phase = 'round_end'; room.inputLocked = false;
    if (!room.testPart) scheduleTransition(room, 'round_end', () => advanceAfterRound(room));
    emit(room); return;
  }
  const index = remaining.shift(); const answer = boardFor(room).answers[index];
  room.message = `${answer.text} — ${answer.points}`; revealSlot(room, index);
  runHostedCue(room, `Number ${index + 1}. ${answer.text}. ${answer.points} people gave that answer.`, null, () => revealRemainingAnswer(room, remaining));
}

function beginFastMoney(room) {
  clearTransition(room);
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
    room.phase = 'round_end'; room.inputLocked = false;
    scheduleTransition(room, 'round_end', () => advanceAfterRound(room)); emit(room);
  });
}

function clearTransition(room){clearTimeout(room.transitionTimer);room.transitionTimer=null;room.transitionAt=null;}
function scheduleTransition(room, phase, next){
  clearTransition(room);room.transitionAt=Date.now()+3000;
  room.transitionTimer=setTimeout(()=>{clearTransition(room);if(rooms.get(room.code)===room&&room.phase===phase)next();},3000);
}
function advanceAfterRound(room){
  if(room.phase!=='round_end'||room.testPart)return;
  clearTransition(room);
  if(room.round<3)beginRound(room,room.round+1);
  else if(room.round===3&&Math.max(...room.scores)<300)beginRound(room,4);
  else beginFastMoney(room);
}
function advanceFastReveal(room){
  if(room.phase!=='fast_reveal_done')return;
  clearTransition(room);
  if(room.fastRevealIndex===0)return startFastPlayer(room,1);
  completeFastMoney(room);
}

function completeFastMoney(room, winningRevealCount = null) {
  const firstTotal=(room.fastScores[0] || []).reduce((a,b)=>a+(Number(b)||0),0);
  const secondScores=winningRevealCount == null ? (room.fastScores[1] || []) : (room.fastScores[1] || []).slice(0,winningRevealCount);
  const total=firstTotal+secondScores.reduce((a,b)=>a+(Number(b)||0),0);
  room.fastWinningRevealCount = winningRevealCount;
  room.phase='fast_results'; room.turnPlayerId=null; room.inputLocked=true;
  room.fastPrize = total>=200 ? 10000 : total*5;
  room.message=total>=200?`You scored ${total} points and won $10,000!`:`You scored ${total} points and won $${room.fastPrize.toLocaleString()}!`;
  emit(room);
}

function startFastPlayer(room, index) {
  clearTransition(room);room.fastAttempt=0;room.fastQuestionQueue=[1,2,3,4];room.fastQuestionAttempts=Array(5).fill(0);room.fastDraftMatches=[];room.fastPendingAnswer=null;room.fastChecking=false;
  clearTimeout(room.fastTimer); room.fastTimer = null; room.fastRevealStep = null;
  room.phase = 'host_wait'; room.fastIndex = index; room.fastRevealIndex = null; room.fastRevealCount = 0; room.fastQuestionIndex = 0; room.fastDraftAnswers = []; room.fastDeadline = null; room.turnPlayerId = room.fastPlayers[index];
  if (index === 0) room.fastWinningRevealCount = null;
  const seconds = index === 0 ? 45 : 60; const name = player(room, room.turnPlayerId).name;
  room.message = `${name} is getting ready for Fast Money.`;
  const firstTotal = (room.fastScores[0] || []).reduce((sum, points) => sum + (Number(points) || 0), 0);
  const scoreReminder = index === 1 ? `${player(room, room.fastPlayers[0]).name} scored ${firstTotal} points, so you need ${Math.max(0, 200 - firstTotal)} points, ${name}. ` : '';
  runHostedCue(room, `${scoreReminder}We need everyone to be quiet for Fast Money. ${name}, your microphone will stay on. You have ${seconds} seconds. The clock starts after I finish reading the first question. Listen carefully and answer each question as quickly as you can. You can pass a question and we will come back to it if there is time.`, 'fast', () => {
    room.phase = 'fast_play';
    askFastQuestion(room);
  });
}

async function checkFastDuplicate(room, qi, given) {
  const answers = room.game.fastMoney[qi].answers;
  const sameWords = normalizeLoose(given) === normalizeLoose(room.fastAnswers[0]?.[qi]);
  let judgment = matchAnswer(given, answers);
  if (!sameWords && judgment.confidence !== 1) judgment = await judgeAnswer(given, answers, [], { timeoutMs: 1500 });
  return { judgment, duplicate: sameWords || (judgment.index >= 0 && judgment.index === room.fastMatches[0]?.[qi]) };
}

async function acceptFastAnswer(room, given) {
  const qi = room.fastQuestionIndex, idx = room.fastIndex, attempt = room.fastAttempt;
  if (idx === 1) {
    room.fastChecking = true;
    const pending = { questionIndex: qi, given, check: checkFastDuplicate(room, qi, given) };
    room.fastPendingAnswer = pending;
    const { judgment, duplicate } = await pending.check;
    if (room.phase !== 'fast_play' || room.fastIndex !== idx || room.fastQuestionIndex !== qi || room.fastAttempt !== attempt) return;
    room.fastChecking = false;
    // A valid submission made before the buzzer still counts if judging finishes after it.
    if (Date.now() >= room.fastDeadline) return finishFastPlayer(room, !duplicate && room.fastQuestionQueue.length === 0 ? 'answered' : 'timeout');
    room.fastPendingAnswer = null;
    if (duplicate) {
      room.fastAttempt++; room.fastQuestionAttempts[qi] = room.fastAttempt; room.message = 'That answer was already given. Try again!';
      runHostedCue(room, 'Try again!', 'fast_duplicate', () => {
        if (room.phase !== 'fast_play') return;
        room.inputLocked = false; emit(room);
      });
      return;
    }
    room.fastDraftMatches[qi] = judgment;
  }
  room.fastDraftAnswers[qi] = given;
  advanceFastQuestion(room);
}

function advanceFastQuestion(room) {
  // Complete the first sweep before returning to passes in the order received.
  const next = room.fastQuestionQueue.shift();
  if (next == null) return void finishFastPlayer(room, 'answered');
  room.fastQuestionIndex = next;
  room.fastAttempt = room.fastQuestionAttempts[next];
  askFastQuestion(room);
}

function askFastQuestion(room) {
  if (room.phase !== 'fast_play') return;
  const question = room.game.fastMoney[room.fastQuestionIndex].question;
  room.message = `Fast Money question ${room.fastQuestionIndex + 1} of 5. Listen to the host.`;
  runHostedCue(room, question, null, () => {
    if (room.phase !== 'fast_play') return;
    if (room.fastQuestionIndex === 0 && !room.fastDeadline) {
      const duration = (room.fastIndex === 0 ? 45 : 60) * 1000;
      room.fastDeadline = Date.now() + duration;
      room.fastTimer = setTimeout(() => void finishFastPlayer(room), duration);
    }
    room.inputLocked = false; emit(room);
  });
}

function startFastReveal(room, index) {
  room.phase = 'fast_reveal'; room.fastRevealIndex = index; room.fastRevealCount = 0; room.fastDeadline = null;
  room.message = `Let's reveal ${player(room, room.fastPlayers[index]).name}'s answers.`;
  revealNextFastAnswer(room);
}

async function finishFastPlayer(room, reason = 'timeout') {
  if (room.judging || room.phase !== 'fast_play') return;
  clearTimeout(room.fastTimer); room.fastTimer = null; cancelHostedCue(room);
  emitCue(room, '', reason === 'answered' ? 'fast_complete' : 'strike', false);
  room.fastChecking = false; room.judging = true; room.inputLocked = true; room.phase = 'fast_judging'; room.fastDeadline = null; emit(room);
  const idx = room.fastIndex;
  const pending = room.fastPendingAnswer;
  if (pending) {
    const { judgment, duplicate } = await pending.check;
    if (!duplicate) {
      room.fastDraftAnswers[pending.questionIndex] = pending.given;
      room.fastDraftMatches[pending.questionIndex] = judgment;
    }
    room.fastPendingAnswer = null;
  }
  const clean = Array.from({ length: 5 }, (_, i) => String(room.fastDraftAnswers[i] || '').slice(0, 80));
  room.fastAnswers[idx] = clean;
  const judgments = await Promise.all(clean.map(async (guess, qi) => {
    if (!guess) return { index: -1 };
    if (room.fastDraftMatches?.[qi]) return room.fastDraftMatches[qi];
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
    room.message = `${player(room, room.fastPlayers[room.fastRevealIndex]).name}'s reveal is complete.`;
    scheduleTransition(room,'fast_reveal_done',()=>advanceFastReveal(room));emit(room);return;
  }
  const i = room.fastRevealCount; const idx = room.fastRevealIndex; const q = room.game.fastMoney[i];
  const guess = room.fastAnswers[idx][i] || 'no answer'; const points = room.fastScores[idx][i] || 0;
  const top = idx === 1 ? ` The number one answer was ${q.answers[0].text}.` : '';
  room.fastRevealStep = 'question'; room.message = q.question;
  runHostedCue(room, q.question, null, () => {
    room.fastRevealStep = 'answer_pending';
    runHostedCue(room, `You said ${guess}.`, null, () => {
      room.fastRevealStep = 'survey'; room.message = 'Survey says…';
      runHostedCue(room, 'Survey says…', null, () => {
        room.fastRevealCount++; room.fastRevealStep = 'points';
        room.message = `${guess} — ${points} points`;
        io.to(room.code).emit('boardReveal', { fastIndex: idx, index: i, points });
        if (idx === 1) {
          const revealedTotal = room.fastScores[0].reduce((sum, value) => sum + (Number(value) || 0), 0)
            + room.fastScores[1].slice(0, room.fastRevealCount).reduce((sum, value) => sum + (Number(value) || 0), 0);
          if (revealedTotal >= 200) return completeFastMoney(room, room.fastRevealCount);
        }
        runHostedCue(room, `${points} ${points === 1 ? 'point' : 'points'}.${top}`, null, () => revealNextFastAnswer(room));
      });
    }, () => {
      room.fastRevealStep = 'answer'; room.message = `You said ${guess}.`; emit(room);
    });
  });
}

function multiplier(round) { return round < 2 ? 1 : round === 2 ? 2 : 3; }
function normalizeLoose(v) { return String(v || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

async function prepareKissImage(room) {
  if (room.era === 'harvey') { room.kissStatus = 'off'; room.kissPlayerId = null; return; }
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
  clearTransition(room);
  clearAnswerClock(room); clearTimeout(room.fastTimer); cancelHostedCue(room); rooms.delete(room.code);
}

async function createAnnouncement(room, index, part) {
  const family = room.families[index];
  const lines = part === 'host' ? `And here's your host, ${ERAS[room.era || 'dawson'].name}!` : part === 'name' ? `${index ? 'And now, introducing' : 'Introducing'} the ${family.name} family!` : `${family.playerIds.map(id => player(room, id).name).join(', ')}!`;
  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts', voice: ERAS[room.era || 'dawson'].voice, input: lines, response_format: 'mp3',
      instructions: `You are an exuberant ${ERAS[room.era || 'dawson'].period} television game-show announcer. Project with big, welcoming energy, build excitement, and pause briefly after each family name and player name. Read the script exactly. Do not imitate any real person.`
    })
  });
  if (!response.ok) throw new Error(`OpenAI speech ${response.status}: ${await response.text()}`);
  return Buffer.from(await response.arrayBuffer());
}

async function createHostSpeech(input, era = 'dawson') {
  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts', voice: ERAS[era].voice, input, response_format: 'mp3',
      instructions: `Deliver a VERY enthusiastic, charismatic ${ERAS[era].period} television game-show performance for an excited live studio audience. Sound delighted to be here: smile audibly, project with bright energy, use lively rising and falling intonation, and put strong expressive emphasis on contestant names, big points, and prizes. Celebrate wins with genuine excitement and make invitations feel like an event. Keep the warmth and playful encouragement even after a wrong answer. Build suspense with one short dramatic pause around Survey says, then deliver the result with a punch. Fast Money questions must be brisk, urgent, upbeat, and exceptionally clear; keep those sentences moving and save the bigger celebrations for the reveals. Avoid a flat, sleepy, solemn, or documentary-style delivery. Be animated without shouting or distorting words. Do not imitate any real person, add question numbers, invent laughter or crowd sounds, or add any words that are not in the script.`
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
if (require.main === module) {
  console.log(`Survey bank ready: ${surveyBank.count()} games in ${surveyBank.directory}`);
  if(process.env.RAILWAY_ENVIRONMENT_ID&&!process.env.RAILWAY_VOLUME_MOUNT_PATH)console.warn('Attach a persistent Railway volume at /data to preserve used-survey history across deployments.');
  refillSurveys();setInterval(refillSurveys,5*60*1000).unref();
  server.listen(port, () => console.log(`Family Feud running on http://localhost:${port}`));
}
module.exports = { server, io, rooms, makeRoom, beginRound, publicRoom, finishHostedCue, openAnswer, answerClockExpired, resolveAnswer, awardRound, beginFastMoney, startFastPlayer, finishFastPlayer, disposeRoom, fallbackEndCredits, prepareEndCredits };
