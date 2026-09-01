const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { BUILTIN_GAME } = require('../src/game');
const { server, io, makeRoom, beginRound, publicRoom, awardRound, beginFastMoney, finishFastPlayer, disposeRoom } = require('../server');

const previousKey = process.env.OPENAI_API_KEY;
delete process.env.OPENAI_API_KEY; // Deterministic offline surveys/judging, never spend API credits in tests.
let url;
test.before(async () => { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); url = `http://127.0.0.1:${server.address().port}`; });
test.after(async () => { await new Promise(resolve => io.close(resolve)); if (previousKey) process.env.OPENAI_API_KEY = previousKey; });
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
  assert.equal(room.pendingCue, null); assert.ok(room.answerDeadline - Date.now() <= 5000);
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
  assert.equal(room.answerDeadline, null); assert.equal(room.inputLocked, true);
  await finish(); assert.equal(room.turnPlayerId, clients[1].id); assert.ok(room.answerDeadline > Date.now());
});

test('five-second answer deadline produces exactly one strike without a client submission', async t => {
  const { room, clients, finish } = await fixture(t);
  const strikes = []; clients[0].on('answerResult', data => strikes.push(data));
  beginRound(room, 0); await finish(); await finish();
  clients[0].emit('buzz', { code: room.code }); await until(() => room.phase === 'answer');
  await until(() => room.judging && room.pendingCue, 6500);
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
  for (let q = 0; q < 5; q++) {
    assert.equal(room.inputLocked, true); await finish();
    const answer = room.game.fastMoney[q].answers[indices[q]].text;
    const result = await clients[0].emitWithAck('submitFastAnswer', { code: room.code, answer, questionIndex: q, fastIndex: room.fastIndex });
    assert.equal(result.ok, true);
    await until(() => room.pendingCue || room.phase === 'fast_reveal');
  }
  await until(() => room.phase === 'fast_reveal');
  assert.equal(room.fastRevealCount, 1);
  assert.equal(publicRoom(room).fastScores[room.fastIndex][1], null, 'No future score leakage');
  for (let q = 0; q < 5; q++) await finish();
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
  room.round = 3; room.scores = [350, 100]; beginFastMoney(room); await finish();
  assert.ok(room.fastTimer); assert.ok(room.pendingCue); assert.equal(room.inputLocked, true);
  await finishFastPlayer(room);
  assert.equal(room.phase, 'fast_reveal'); assert.deepEqual(room.fastAnswers[0], ['', '', '', '', '']);
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
