const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function browser(fetchImpl) {
  const events = [], handlers = {}, audioInstances = [];
  const app = { innerHTML: '', append() {} };
  const context = vm.createContext({
    console, setTimeout, clearTimeout, setInterval, clearInterval, AbortController, Promise, Date,
    document: { querySelector: () => app },
    location: { pathname: '/join/TEST' },
    localStorage: { getItem: () => '{"code":"TEST","playerId":"P"}' },
    io: () => ({ on: (name, fn) => handlers[name] = fn, emit: (name, value) => events.push({ name, value }) }),
    window: { speechSynthesis: { speak: () => { throw new Error('Cancelled audio must not fall back to speech'); }, cancel() {} } },
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    fetch: fetchImpl,
    Audio: class {
      constructor() { audioInstances.push(this); }
      play() { this.onplaying?.(); return Promise.resolve(); }
      pause() { this.paused = true; }
    }
  });
  context.speechSynthesis = context.window.speechSynthesis;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/dawson.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'), context);
  vm.runInContext("state={mode:'remote',adminId:'P'};myPlayerId='P';roomCode='TEST';audioEnabled=true", context);
  return { context, events, handlers, audioInstances };
}

test('cancelling an in-flight speech download settles without restarting the question as fallback speech', async () => {
  const b = browser((url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))));
  const playing = vm.runInContext("playHostSpeech('/question','Question to cancel',12)", b.context);
  vm.runInContext('cancelHostCue(12)', b.context);
  await playing;
  assert.equal(b.events.filter(e => e.name === 'cueStarted').length, 0);
});

test('cancelling playing question pauses it, resolves the queue and lets the next host cue play', async () => {
  const b = browser(async () => ({ ok: true, status: 200, blob: async () => ({}) }));
  const playing = vm.runInContext("playHostSpeech('/question','Question',21)", b.context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(b.events[0].name, 'cueStarted');
  vm.runInContext('cancelHostCue(21)', b.context); await playing;
  assert.equal(b.audioInstances[0].paused, true);
  const next = vm.runInContext("playHostSpeech('/next','Next question',22)", b.context);
  await new Promise(resolve => setImmediate(resolve)); b.audioInstances[1].onended(); await next;
  assert.equal(b.events[1].value.cueId, 22);
});

test('Fast Money form has one answer, an explicit submit button, and no question text', () => {
  const b = browser(async () => ({}));
  vm.runInContext("state={fastQuestionIndex:2,game:{fastMoney:[{question:'Hidden secret question'}]}}", b.context);
  const html = vm.runInContext('fastForm()', b.context);
  assert.match(html, /type="submit"/); assert.match(html, /ANSWER 3 OF 5/);
  assert.doesNotMatch(html, /Hidden secret question/);
  assert.equal((html.match(/<input/g) || []).length, 1);
});

test('Dawson board is column-major, has eight physical slots and uses data-driven dot scores', () => {
  const b = browser(async () => ({}));
  vm.runInContext('state={round:2}', b.context);
  const html = vm.runInContext("dawsonBoard({answers:[{text:'KEYS',points:31},...Array.from({length:6},()=>({text:null}))]})", b.context);
  assert.equal((html.match(/data-board-slot/g) || []).length, 8);
  assert.match(html, /data-board-slot="4" style="grid-row:1;grid-column:2"/);
  assert.match(html, /DOUBLE/);
  assert.match(vm.runInContext('dotNumber(153)', b.context), /aria-label="153"/);
});

test('test controls follow the active sample contestant, remain absent for regular players, and stop at round one', () => {
  const b = browser(async () => ({}));
  vm.runInContext("state={testPart:'intro',adminId:'P',phase:'answer',turnPlayerId:'sample',inputLocked:false}", b.context);
  assert.match(vm.runInContext('controls()', b.context), /answerForm/);
  vm.runInContext("state.testPart=null", b.context);
  assert.doesNotMatch(vm.runInContext('controls()', b.context), /answerForm/);
  vm.runInContext("state.testPart='intro';state.phase='round_end'", b.context);
  assert.match(vm.runInContext('controls()', b.context), /Test complete/);
  assert.doesNotMatch(vm.runInContext('controls()', b.context), /Next Round/);
  vm.runInContext("state.testPart='fast';state.phase='fast_play';state.fastQuestionIndex=0", b.context);
  assert.match(vm.runInContext('controls()', b.context), /fastForm/);
});
