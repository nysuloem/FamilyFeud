const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { BUILTIN_GAME } = require('../src/game');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const bankDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'feud-flow-bank-'));
const previousDirectory = process.env.DATA_DIR;
process.env.DATA_DIR = bankDirectory;
const { server, io, rooms, makeRoom, beginRound, publicRoom, awardRound, beginFastMoney, finishFastPlayer, openAnswer, answerClockExpired, disposeRoom } = require('../server');

if (previousDirectory === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousDirectory;
const previousKey = process.env.OPENAI_API_KEY;
delete process.env.OPENAI_API_KEY; // Deterministic offline surveys/judging, never spend API credits in tests.
let url;
test.before(async () => { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); url = `http://127.0.0.1:${server.address().port}`; });
test.after(async () => { await new Promise(resolve => io.close(resolve)); fs.rmSync(bankDirectory, {recursive:true,force:true}); if (previousKey) process.env.OPENAI_API_KEY = previousKey; });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 2500) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('State transition timed out'); await pause(5); }
}
async function fixture(t) {
  const room = makeRoom('remote'), clients = [];
  for (const name of ['Alice', 'Bob']) {
    const client = connect(url, { transports: ['websocket'], forceNew: true }); clients.push(client);
    await new Promise(resolve => client.once('connect', resolve));
    const joined = await client.emitWithAck('joinRoom', { code: room.code, name, familyName: name, photo: 'data:image/png;base64,AAAA' });
    assert.equal(joined.ok, true);
  }
  room.game = structuredClone(BUILTIN_GAME);
  room.families = room.players.map(p => ({ name: p.name, playerIds: [p.id] }));
  t.after(() => { disposeRoom(room); clients.forEach(c => c.disconnect()); });
  const finish = async () => {
    const id = room.pendingCue?.cueId; assert.ok(id, 'Host must have an active cue');
    clients[0].emit('cueFinished', { code: room.code, cueId: id });
    await until(() => room.pendingCue?.cueId !== id);
  };
  return { room, clients, finish };
}

test('early buzz cancels speech; second contestant hears full question; answer submissions are serialized', async t => {
  const { room, clients, finish } = await fixture(t);
  beginRound(room, 0);
  assert.match(room.speechCues.get(room.pendingCue.cueId).text, /Let's have Alice.*Let's have Bob/);
  const invitation = room.pendingCue.cueId;
  clients[1].emit('cueFinished', { code: room.code, cueId: invitation }); await pause(10);
  assert.equal(room.pendingCue.cueId, invitation, 'Only the host audio controller can advance');
  clients[0].emit('buzz', { code: room.code }); await pause(20); assert.equal(room.phase, 'faceoff');
  await finish(); // Invitation -> question is loading, not yet playing.
  const questionCue = room.pendingCue.cueId;
  clients[0].emit('buzz', { code: room.code }); await pause(20); assert.equal(room.faceoff.buzzedBy, null);
  clients[0].emit('cueStarted', { code: room.code, cueId: questionCue }); await until(() => room.faceoff.canBuzz);
  const cancelled = []; clients[1].on('cancelCue', data => cancelled.push(data.cueId));
  clients[0].emit('buzz', { code: room.code }); await until(() => room.phase === 'answer');
  assert.equal(room.pendingCue, null); assert.ok(room.answerDeadline - Date.now() <= 15000);
  await until(() => cancelled.includes(questionCue));
  clients[0].emit('cueFinished', { code: room.code, cueId: questionCue }); await pause(10);
  assert.equal(room.phase, 'answer');
  const token = room.answerToken;
  const result = await clients[0].emitWithAck('submitAnswer', { code: room.code, token, answer: 'phone' });
  assert.equal(result.ok, true); await until(() => room.pendingCue);
  assert.equal(room.answerDeadline, null);
  const duplicate = await clients[0].emitWithAck('submitAnswer', { code: room.code, token, answer: 'keys' });
  assert.equal(duplicate.ok, false); assert.deepEqual(room.revealed, []);
  await finish(); assert.deepEqual(room.revealed, [1]); // Survey result now flips.
  await finish(); // Result -> complete question for the other player.
  assert.match(room.speechCues.get(room.pendingCue.cueId).text, /Let me read Bob the entire question before they answer/);
  assert.ok(!publicRoom(room).message.includes(room.game.rounds[0].question), 'Spoken question must stay out of the visible banner');
  assert.equal(room.answerDeadline, null); assert.equal(room.inputLocked, true);
  await finish(); assert.equal(room.turnPlayerId, clients[1].id); assert.ok(room.answerDeadline > Date.now());
});

test('15-second answer deadline produces exactly one strike without a client submission', async t => {
  const { room, clients, finish } = await fixture(t);
  const strikes = []; clients[0].on('answerResult', data => strikes.push(data));
  beginRound(room, 0); await finish(); await finish();
  clients[0].emit('buzz', { code: room.code }); await until(() => room.phase === 'answer');
  await until(() => room.judging && room.pendingCue, 16500);
  await until(() => strikes.length === 1);
  assert.equal(strikes[0].timedOut, true); assert.equal(strikes[0].count, 1);
  const late = await clients[0].emitWithAck('submitAnswer', { code: room.code, token: room.answerToken, answer: 'keys' });
  assert.equal(late.ok, false); assert.deepEqual(room.revealed, []);
  await pause(30); assert.equal(strikes.length, 1);
});

test('remaining answers reveal one at a time, and next round is unavailable until finished', async t => {
  const { room, finish } = await fixture(t);
  room.round = 0; room.revealed = [0]; room.bank = 31;
  awardRound(room, 0); assert.equal(room.phase, 'round_reveal'); assert.deepEqual(room.revealed, [0]);
  for (let i = 1; i < 7; i++) { await finish(); assert.equal(room.revealed.length, i + 1); assert.equal(room.phase, 'round_reveal'); }
  await finish(); assert.equal(room.phase, 'round_end'); assert.equal(room.scores[0], 31);
});

async function playFast(f, indices) {
  const { room, clients, finish } = f;
  await finish(); // Preparation -> first question.
  assert.equal(room.fastDeadline, null, 'First question must finish before the clock starts');
  assert.equal(room.fastTimer, null);
  let deadline;
  for (let q = 0; q < 5; q++) {
    assert.equal(room.inputLocked, true);
    assert.equal(room.speechCues.get(room.pendingCue.cueId).text, room.game.fastMoney[q].question);
    await finish();
    if (q === 0) { deadline = room.fastDeadline; assert.ok(deadline > Date.now()); }
    else assert.equal(room.fastDeadline, deadline, 'Later questions use the same running clock');
    const answer = room.game.fastMoney[q].answers[indices[q]].text;
    const result = await clients[0].emitWithAck('submitFastAnswer', { code: room.code, answer, questionIndex: q, fastIndex: room.fastIndex });
    assert.equal(result.ok, true);
    await until(() => room.pendingCue || room.phase === 'fast_reveal');
  }
  await until(() => room.phase === 'fast_reveal');
  assert.equal(room.fastRevealCount, 0);
  assert.equal(publicRoom(room).fastScores[room.fastIndex][1], null, 'No future score leakage');
  for (let q = 0; q < 5; q++) {
    const idx = room.fastIndex;
    assert.equal(room.fastRevealStep, 'question');
    assert.equal(room.speechCues.get(room.pendingCue.cueId).text, room.game.fastMoney[q].question);
    assert.equal(publicRoom(room).fastAnswers[idx][q], null);
    assert.equal(publicRoom(room).fastScores[idx][q], null);
    await finish(); // Question -> answer readback.
    assert.match(room.speechCues.get(room.pendingCue.cueId).text, /^You said /);
    assert.equal(publicRoom(room).fastAnswers[idx][q], null, 'Answer waits for readback playback to start');
    clients[0].emit('cueStarted', { code: room.code, cueId: room.pendingCue.cueId });
    await until(() => room.fastRevealStep === 'answer');
    assert.equal(publicRoom(room).fastAnswers[idx][q], room.fastAnswers[idx][q]);
    assert.equal(publicRoom(room).fastScores[idx][q], null);
    await finish(); // Answer -> Survey says.
    assert.equal(room.speechCues.get(room.pendingCue.cueId).text, 'Survey says…');
    assert.equal(publicRoom(room).fastScores[idx][q], null);
    await finish(); // Survey says -> points and effect.
    assert.equal(publicRoom(room).fastScores[idx][q], room.fastScores[idx][q]);
    if(q < 4) assert.equal(publicRoom(room).game.fastMoney[q+1].question, null);
    await finish(); // Points -> next question.
  }
  assert.equal(room.phase, 'fast_reveal_done');
}

test('both Fast Money players progress through real reveals to $10,000; questions stay off play screens', async t => {
  const f = await fixture(t), { room, clients } = f;
  room.round = 3; room.scores = [350, 100]; beginFastMoney(room);
  assert.equal(room.round, -1, 'Fast Money must not render the old main board');
  assert.ok(publicRoom(room).game.fastMoney.every(q => q.question === null));
  await playFast(f, [0, 0, 0, 0, 0]);
  clients[0].emit('continueFastMoney', { code: room.code }); await until(() => room.fastIndex === 1);
  await playFast(f, [1, 1, 1, 1, 1]);
  assert.equal(room.fastPrize, 10000);
  assert.ok(publicRoom(room).fastTopAnswers.every(Boolean));
  clients[0].emit('continueFastMoney', { code: room.code }); await until(() => room.phase === 'fast_results');
});

test('server can end Fast Money during an unfinished spoken question and score unanswered entries', async t => {
  const f = await fixture(t), { room, finish } = f;
  room.round = 3; room.scores = [350, 100]; beginFastMoney(room); await finish(); await finish();
  await f.clients[0].emitWithAck('submitFastAnswer', { code: room.code, answer: 'xyzzy', questionIndex: 0, fastIndex: 0 });
  assert.ok(room.fastTimer); assert.ok(room.pendingCue); assert.equal(room.inputLocked, true);
  await finishFastPlayer(room);
  assert.equal(room.phase, 'fast_reveal'); assert.deepEqual(room.fastAnswers[0], ['xyzzy', '', '', '', '']);
  assert.deepEqual(room.fastScores[0], [0, 0, 0, 0, 0]);
});

test('repeated second-player Fast Money answers score zero and under-200 payouts are five times the score', async t => {
  const f = await fixture(t), { room, clients } = f;
  room.round = 3; room.scores = [350, 100]; beginFastMoney(room);
  await playFast(f, [0, 0, 0, 0, 0]);
  clients[0].emit('continueFastMoney', { code: room.code }); await until(() => room.fastIndex === 1);
  await playFast(f, [0, 0, 0, 0, 0]);
  assert.deepEqual(room.fastScores[1], [0, 0, 0, 0, 0]);
  assert.equal(room.fastPrize, room.fastScores[0].reduce((a, b) => a + b, 0) * 5);
});

async function rehearsal(t, part) {
  const client = connect(url, { transports: ['websocket'], forceNew: true });
  await new Promise(resolve => client.once('connect', resolve));
  const created = await client.emitWithAck('createTestRoom', { part, name: 'Pat' });
  assert.equal(created.ok, true);
  const room = rooms.get(created.code);
  t.after(() => { disposeRoom(room); client.disconnect(); });
  const finish = async () => {
    const id = room.pendingCue?.cueId; assert.ok(id);
    client.emit('cueFinished', { code: room.code, cueId: id });
    await until(() => room.pendingCue?.cueId !== id);
  };
  return { room, clients: [client], finish };
}

test('solo introduction test controls the opponent and ends after the first round', async t => {
  const { room, clients: [client], finish } = await rehearsal(t, 'intro');
  assert.equal(room.phase, 'intro'); assert.equal(room.round, -1);
  assert.equal(room.players.length, 4); assert.equal(room.kissStatus, 'off');
  assert.deepEqual(room.families.map(f => f.playerIds.length), [2, 2]);
  assert.equal(room.players[0].name, 'Pat');
  client.emit('introComplete', { code: room.code }); await until(() => room.phase === 'faceoff');
  await finish(); await finish();
  const opponent = room.faceoff.players[1];
  client.emit('buzz', { code: room.code, playerId: opponent }); await until(() => room.phase === 'answer');
  assert.equal(room.turnPlayerId, opponent);
  const answer = await client.emitWithAck('submitAnswer', { code: room.code, token: room.answerToken, answer: 'phone' });
  assert.equal(answer.ok, true); await until(() => room.pendingCue);
  await finish(); await finish();
  assert.match(room.speechCues.get(room.pendingCue.cueId).text, /Let me read Pat the entire question/);
  await finish();
  assert.equal((await client.emitWithAck('submitAnswer', { code: room.code, token: room.answerToken, answer: 'keys' })).ok, true);
  await until(() => room.pendingCue); await finish(); await finish(); await finish();
  assert.equal(room.phase, 'decision');
  client.emit('playOrPass', { code: room.code, choice: 'pass' }); await until(() => room.phase === 'host_wait');
  await finish(); assert.equal(room.controlFamily, 1);
  // Intentionally strike out and fail the steal, exercising every sample player's turn.
  for (let i = 0; i < 4; i++) {
    assert.equal((await client.emitWithAck('submitAnswer', { code: room.code, token: room.answerToken, answer: 'xyzzy' })).ok, true);
    await until(() => room.pendingCue); await finish(); await finish();
    if (i === 1) { assert.match(room.speechCues.get(room.pendingCue.cueId).text, /get ready to steal/); await finish(); }
    if (i < 3) await finish();
  }
  assert.equal(room.phase, 'round_reveal');
  while (room.pendingCue) await finish();
  assert.equal(room.phase, 'round_end'); assert.equal(room.revealed.length, 7);
  client.emit('nextRound', { code: room.code }); await pause(20);
  assert.equal(room.round, 0); assert.equal(room.phase, 'round_end');
  assert.match(room.message, /test complete/);
});

test('solo Fast Money test runs both selected contestants and both reveals without playing main rounds', async t => {
  const f = await rehearsal(t, 'fast'), { room, clients: [client] } = f;
  assert.equal(room.phase, 'fast_select'); assert.equal(room.round, -1);
  assert.equal(room.kissStatus, 'off');
  const playerIds = [...room.families[0].playerIds].reverse();
  client.emit('selectFastPlayers', { code: room.code, playerIds }); await until(() => room.pendingCue);
  assert.equal(room.turnPlayerId, playerIds[0]);
  await playFast(f, [0, 0, 0, 0, 0]);
  client.emit('continueFastMoney', { code: room.code }); await until(() => room.fastIndex === 1);
  await playFast(f, [1, 1, 1, 1, 1]);
  client.emit('continueFastMoney', { code: room.code }); await until(() => room.phase === 'fast_results');
  assert.equal(room.fastPrize, 10000);
});

test('test mode cannot override ordinary turns or be claimed by a spectator', async t => {
  const normal = await fixture(t), { room, clients, finish } = normal;
  beginRound(room, 0); await finish(); await finish();
  clients[0].emit('buzz', { code: room.code, playerId: clients[1].id }); await until(() => room.phase === 'answer');
  assert.equal(room.turnPlayerId, clients[0].id, 'Regular rooms ignore impersonation');
  assert.equal((await clients[1].emitWithAck('submitAnswer', { code: room.code, token: room.answerToken, answer: 'keys' })).ok, false);
  const f = await rehearsal(t, 'intro');
  const spectator = clients[1];
  assert.equal((await spectator.emitWithAck('rejoin', { code: f.room.code, playerId: f.room.players[1].id })).ok, false);
  spectator.emit('watchRoom', { code: f.room.code }); await pause(10);
  spectator.emit('introComplete', { code: f.room.code }); await pause(10); assert.equal(f.room.phase, 'intro');
  clients[0].emit('introComplete', { code: f.room.code }); await pause(10); assert.equal(f.room.phase, 'intro');
  f.clients[0].emit('introComplete', { code: f.room.code }); await until(() => f.room.phase === 'faceoff');
  await f.finish(); await f.finish();
  spectator.emit('buzz', { code: f.room.code, playerId: f.room.faceoff.players[1] }); await pause(20);
  assert.equal(f.room.phase, 'faceoff'); assert.equal(f.room.faceoff.buzzedBy, null);
});

test('test setup validates its entry point and requires an actual upload for souvenir consent', async t => {
  const client = connect(url, { transports: ['websocket'], forceNew: true });
  await new Promise(resolve => client.once('connect', resolve)); t.after(() => client.disconnect());
  const count = rooms.size;
  assert.equal((await client.emitWithAck('createTestRoom', { part: 'bad' })).ok, false);
  assert.equal((await client.emitWithAck('createTestRoom', { part: 'intro', kissConsent: true })).ok, false);
  assert.equal((await client.emitWithAck('createTestRoom', { part: 'intro', photo: '<script>' })).ok, false);
  assert.equal(rooms.size, count);
});

test('a solo test owner can reconnect and still control sample contestants', async t => {
  const { room, clients: [original] } = await rehearsal(t, 'fast');
  const oldId = original.id; original.disconnect();
  const client = connect(url, { transports: ['websocket'], forceNew: true });
  await new Promise(resolve => client.once('connect', resolve)); t.after(() => client.disconnect());
  const result = await client.emitWithAck('rejoin', { code: room.code, playerId: oldId });
  assert.equal(result.ok, true); assert.equal(room.adminId, client.id); assert.equal(room.fastSelectorId, client.id);
  assert.ok(room.families[0].playerIds.includes(client.id));
  client.emit('selectFastPlayers', { code: room.code, playerIds: [...room.families[0].playerIds].reverse() });
  await until(() => room.pendingCue);
  for (let i = 0; i < 2; i++) {
    const cueId = room.pendingCue.cueId; client.emit('cueFinished', { code: room.code, cueId });
    await until(() => room.pendingCue?.cueId !== cueId);
  }
  assert.equal(room.turnPlayerId, room.players[1].id);
  assert.equal((await client.emitWithAck('submitFastAnswer', { code: room.code, answer: 'pizza', questionIndex: 0, fastIndex: 0 })).ok, true);
});

test('two faceoff misses move down both families in original buzz order without reopening buzzers', async t => {
  const { room, clients: [client], finish } = await rehearsal(t, 'intro');
  client.emit('introComplete', { code: room.code }); await until(() => room.phase === 'faceoff');
  await finish(); await finish();
  const original = [...room.faceoff.players], firstBuzzer = original[1];
  client.emit('buzz', { code: room.code, playerId: firstBuzzer }); await until(() => room.phase === 'answer');
  const give = async text => {
    assert.equal((await client.emitWithAck('submitAnswer', { code: room.code, token: room.answerToken, answer: text })).ok, true);
    await until(() => room.pendingCue); await finish(); await finish();
  };
  await give('xyzzy'); await finish(); assert.equal(room.turnPlayerId, original[0]);
  await give('xyzzy');
  assert.equal(room.phase, 'host_wait'); assert.equal(room.faceoff.buzzedBy, firstBuzzer);
  assert.equal(room.faceoff.canBuzz, false); assert.equal(room.faceoff.attempts.length, 2);
  assert.deepEqual(room.faceoff.players, [room.players[1].id, room.players[3].id]);
  assert.equal(room.turnPlayerId, room.players[3].id); assert.equal(room.answerDeadline, null);
  client.emit('buzz', { code: room.code, playerId: room.players[1].id }); await pause(10);
  assert.equal(room.turnPlayerId, room.players[3].id);
  await finish(); assert.ok(room.answerDeadline > Date.now());
  await give('phone');
  assert.equal(room.turnPlayerId, room.players[1].id);
  assert.match(room.speechCues.get(room.pendingCue.cueId).text, /Let me read Sam the entire question/);
  await finish(); await give('keys'); await finish();
  assert.equal(room.phase, 'decision'); assert.equal(room.faceoff.winnerFamily, 0);
  assert.deepEqual(room.revealed, [1, 0]);
});

test('continued faceoff wraps uneven families and a number one answer immediately wins', async t => {
  const { room, clients: [client], finish } = await rehearsal(t, 'intro');
  room.families[1].playerIds = [room.players[2].id];
  client.emit('introComplete', { code: room.code }); await until(() => room.phase === 'faceoff');
  await finish(); await finish();
  client.emit('buzz', { code: room.code, playerId: client.id }); await until(() => room.phase === 'answer');
  for (let i = 0; i < 4; i++) {
    assert.equal((await client.emitWithAck('submitAnswer', { code: room.code, token: room.answerToken, answer: 'xyzzy' })).ok, true);
    await until(() => room.pendingCue); await finish(); await finish(); await finish();
    assert.equal(room.faceoff.canBuzz, false);
  }
  assert.deepEqual(room.faceoff.players, [client.id, room.players[2].id]);
  assert.equal(room.turnPlayerId, client.id); assert.equal(room.faceoff.attempts.length, 4);
  assert.equal((await client.emitWithAck('submitAnswer', { code: room.code, token: room.answerToken, answer: 'keys' })).ok, true);
  await until(() => room.pendingCue); await finish(); assert.equal(room.faceoff.showBoard, true);
  await finish(); await finish();
  assert.equal(room.phase, 'decision'); assert.equal(room.faceoff.winnerFamily, 0);
  assert.equal(room.faceoff.attempts.length, 5, 'No extra opposing guess after number one');
});

test('steal allows 30 seconds, accepts answers during the warning, and cancels stale warning completion',async t=>{
  const {room,clients,finish}=await fixture(t);
  room.round=0;room.controlFamily=0;room.isSteal=true;
  openAnswer(room,clients[0].id);
  assert.ok(room.answerDeadline-Date.now()>29000);
  clearTimeout(room.answerTimer);answerClockExpired(room,room.answerToken);
  assert.equal(room.answerDeadline,null);assert.equal(room.stealWarning,true);assert.equal(room.inputLocked,false);
  const warning=room.pendingCue.cueId;
  assert.equal(room.speechCues.get(warning).text,'I need an answer!');
  const result=await clients[0].emitWithAck('submitAnswer',{code:room.code,token:room.answerToken,answer:'keys'});
  assert.equal(result.ok,true);await until(()=>room.pendingCue?.cueId!==warning);
  clients[0].emit('cueFinished',{code:room.code,cueId:warning});await pause(10);
  assert.equal(room.answerDeadline,null);assert.equal(room.judging,true);
  await finish();await finish();assert.equal(room.phase,'round_reveal');
});

test('steal final three seconds start only after the warning finishes and expire once',async t=>{
  const {room,clients,finish}=await fixture(t),strikes=[];
  clients[0].on('answerResult',result=>strikes.push(result));
  room.round=0;room.controlFamily=0;room.isSteal=true;openAnswer(room,clients[0].id);
  clearTimeout(room.answerTimer);answerClockExpired(room,room.answerToken);
  assert.equal(strikes.length,0);assert.equal(room.answerDeadline,null);
  await finish();assert.ok(room.answerDeadline-Date.now()>2800);assert.ok(room.answerDeadline-Date.now()<=3000);
  clearTimeout(room.answerTimer);answerClockExpired(room,room.answerToken);answerClockExpired(room,room.answerToken);
  await until(()=>strikes.length===1);assert.equal(strikes[0].timedOut,true);
});

test('Good Answer reactions are teammate-only, once per turn, and never alter the answer timer',async t=>{
  const {room,clients}=await fixture(t),reactions=[];
  room.round=0;room.controlFamily=0;openAnswer(room,clients[0].id);
  clients[0].on('goodAnswer',r=>reactions.push(r));
  clients[0].emit('goodAnswer',{code:room.code});clients[1].emit('goodAnswer',{code:room.code});
  await pause(15);assert.equal(reactions.length,0,'Answerer and opponent cannot cheer');
  room.families=[{name:'Team',playerIds:room.players.map(p=>p.id)},{name:'Other',playerIds:[]}];
  const deadline=room.answerDeadline;
  clients[1].emit('goodAnswer',{code:room.code});clients[1].emit('goodAnswer',{code:room.code});
  await until(()=>reactions.length===1);assert.equal(room.answerDeadline,deadline);
  assert.equal(reactions[0].name,'Bob');
});


test('regular starts immediately load distinct prepared games without consuming test fixtures',async t=>{
  const first=await fixture(t),second=await fixture(t);
  const start=Date.now();
  assert.equal((await first.clients[0].emitWithAck('startGame',{code:first.room.code})).ok,true);
  await until(()=>first.room.phase==='intro');
  assert.ok(Date.now()-start<2000,'Starting a prepared game must not wait for survey generation');
  assert.equal((await second.clients[0].emitWithAck('startGame',{code:second.room.code})).ok,true);
  await until(()=>second.room.phase==='intro');
  assert.notEqual(first.room.game.id,second.room.game.id);
  assert.notEqual(first.room.game.rounds[0].question,BUILTIN_GAME.rounds[0].question);
  const history=JSON.parse(fs.readFileSync(path.join(bankDirectory,'survey-bank.json'),'utf8'));
  assert.equal(history.used.length,2);assert.equal(history.available.length,10);
});
