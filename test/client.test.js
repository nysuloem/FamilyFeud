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
  vm.runInContext("state.testPart='fast';state.phase='fast_play';state.fastQuestionIndex=0;state.fastIndex=0;state.fastPlayers=['sample']", b.context);
  assert.match(vm.runInContext('controls()', b.context), /fastForm/);
});

test('faceoff scene and buzzer coexist remotely, while the TV display never has a buzzer', () => {
  const b = browser(async () => ({}));
  vm.runInContext("state={mode:'remote',phase:'faceoff',round:0,controlFamily:null,players:[{id:'P',name:'Pat',photo:'a'},{id:'Q',name:'Sam',photo:'b'}],families:[{name:'One',playerIds:['P']},{name:'Two',playerIds:['Q']}],faceoff:{players:['P','Q'],winnerFamily:null,buzzedBy:null,canBuzz:true,showBoard:false}}", b.context);
  assert.equal(vm.runInContext('showFaceoffScene()', b.context), true);
  assert.match(vm.runInContext('dawsonFaceoff()', b.context), /Richard Dawson faceoff podium/);
  assert.match(vm.runInContext('controls()', b.context), /BUZZ!/);
  vm.runInContext("state.mode='host';isDisplay=true", b.context);
  assert.doesNotMatch(vm.runInContext('controls()', b.context), /<button/);
  assert.equal(vm.runInContext('showFaceoffScene()', b.context), true);
  vm.runInContext("isDisplay=false;state.mode='remote';state.testPart='intro';state.adminId='P'", b.context);
  assert.equal((vm.runInContext('controls()', b.context).match(/data-test-buzz/g) || []).length, 2);
  vm.runInContext("state.phase='answer';state.faceoff.buzzedBy='P'", b.context);
  assert.equal(vm.runInContext('showFaceoffScene()', b.context), true);
  vm.runInContext('state.faceoff.showBoard=true', b.context);
  assert.equal(vm.runInContext('showFaceoffScene()', b.context), false, 'Successful answer reveals use the main board camera');
});

test('Fast Money microphone stays active across questions, ignores host speech and stale results, and stops after play', async () => {
  const b = browser(async () => ({})), microphones = [];
  b.context.document.querySelector = () => null;
  b.context.window.SpeechRecognition = class {
    constructor(){ microphones.push(this); }
    start(){ this.started = true; }
    abort(){ this.aborted = true; this.onend?.(); }
  };
  vm.runInContext("state={code:'TEST',mode:'remote',adminId:'P',phase:'host_wait',turnPlayerId:'P',fastPlayers:['P'],fastIndex:0,fastQuestionIndex:0,inputLocked:true};syncFastMicrophone()", b.context);
  const mic = microphones[0];
  assert.equal(mic.started, true); assert.equal(mic.continuous, true);
  const heard = words => mic.onresult({resultIndex:0,results:[Object.assign([{transcript:words}],{isFinal:true})]});
  mic.onspeechstart(); heard('The host is speaking');
  assert.equal(vm.runInContext('fastDraft.value', b.context), '');
  vm.runInContext("state.phase='fast_play';state.inputLocked=false;syncFastMicrophone()", b.context);
  heard('Delayed host result');
  assert.equal(vm.runInContext('fastDraft.value', b.context), '');
  mic.onspeechstart(); heard('coffee');
  assert.equal(vm.runInContext('fastDraft.value', b.context), 'coffee');
  vm.runInContext('state.fastQuestionIndex=1;state.inputLocked=true;syncFastMicrophone()', b.context);
  assert.equal(microphones.length, 1, 'Question transitions must keep the same microphone');
  vm.runInContext('state.inputLocked=false', b.context); heard('Late first answer');
  assert.equal(vm.runInContext('fastDraft.value', b.context), '');
  mic.onspeechstart(); heard('blue');
  assert.equal(vm.runInContext('fastDraft.value', b.context), 'blue');
  mic.onend(); await new Promise(resolve => setTimeout(resolve, 280));
  assert.equal(microphones.length, 2, 'Browser-ended sessions restart automatically');
  vm.runInContext("state.phase='fast_reveal';syncFastMicrophone()", b.context);
  assert.equal(microphones[1].aborted, true);
  assert.equal(vm.runInContext('fastMic', b.context), null);
});

test('microphone denial permits typing and does not repeatedly request permission', () => {
  const b = browser(async () => ({})), microphones = [];
  b.context.document.querySelector = () => null;
  b.context.window.SpeechRecognition = class {
    constructor(){ microphones.push(this); }
    start(){}
    abort(){ this.onend?.(); }
  };
  vm.runInContext("state={code:'TEST',mode:'remote',adminId:'P',phase:'fast_play',turnPlayerId:'P',fastPlayers:['P'],fastIndex:0,fastQuestionIndex:0,inputLocked:false};syncFastMicrophone()", b.context);
  microphones[0].onerror({error:'not-allowed'});
  vm.runInContext('syncFastMicrophone()', b.context);
  assert.equal(microphones.length, 1);
  assert.match(vm.runInContext('fastMicError', b.context), /also type/);
  assert.doesNotMatch(vm.runInContext('fastForm()', b.context), /disabled/);
});

test('Fast Money board displays an answer without leaking its score; zero uses the strike effect', () => {
  const b=browser(async()=>({}));
  vm.runInContext("state={phase:'fast_reveal',fastIndex:0,fastRevealIndex:0,fastRevealCount:0,fastPlayers:['P'],players:[{id:'P',name:'Pat',photo:'a'}],fastAnswers:[['coffee',null,null,null,null],null],fastScores:[[null,null,null,null,null],null]}",b.context);
  const html=vm.runInContext('dawsonFastStage()',b.context);
  assert.match(html,/<span>coffee<\/span><b><\/b>/);
  b.context.requestAnimationFrame=()=>{};
  vm.runInContext('var effects=[];playEffect=type=>effects.push(type)',b.context);
  b.handlers.boardReveal({fastIndex:0,index:0,points:0});
  b.handlers.boardReveal({fastIndex:0,index:1,points:1});
  b.handlers.boardReveal({index:0});
  assert.equal(vm.runInContext('effects.join(",")',b.context),'strike,ding,ding');
});

test('family announcements and oval reveals finish one family before introducing the other', async () => {
  const b=browser(async()=>({})), scenes=[], stages=[];
  const content={set innerHTML(value){scenes.push(value);},querySelector(){return {classList:{add(){stages.push('slide');}}};}};
  b.context.document.querySelector=()=>content;
  b.context.setTimeout=fn=>{fn();return 1;};
  b.context.stages=stages;
  vm.runInContext("state={code:'TEST',mode:'remote',phase:'intro',adminId:'P',players:[{id:'P',name:'Pat',photo:'a'},{id:'Q',name:'Sam',photo:'b'}],families:[{name:'Brown',playerIds:['P']},{name:'Smith',playerIds:['Q']}],kissStatus:'off'};playAudioFile=async()=>{};playFamilyAnnouncement=async(i,part)=>stages.push(i+':'+part)",b.context);
  await vm.runInContext('runIntro()',b.context);
  assert.deepEqual(stages,['0:name','slide','0:members','1:name','slide','1:members']);
  assert.match(scenes[0],/Brown/);assert.doesNotMatch(scenes[0],/Smith/);
  assert.match(scenes[1],/Smith/);assert.doesNotMatch(scenes[1],/Brown/);
  assert.equal(b.events.at(-1).name,'introComplete');
});
