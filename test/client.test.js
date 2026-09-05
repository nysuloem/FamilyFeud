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
    document: { querySelector: selector => selector === '#app' ? app : null },
    location: { pathname: '/join/TEST' },
    localStorage: { getItem: () => '{"code":"TEST","playerId":"P"}' },
    io: () => ({ on: (name, fn) => handlers[name] = fn, emit: (name, value) => events.push({ name, value }) }),
    window: { speechSynthesis: { speak: () => { throw new Error('Cancelled audio must not fall back to speech'); }, cancel() {} } },
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    fetch: fetchImpl,
    Audio: class {
      constructor(src) { this.src=src; audioInstances.push(this); }
      play() { this.onplaying?.(); return Promise.resolve(); }
      pause() { this.paused = true; }
    }
  });
  context.speechSynthesis = context.window.speechSynthesis;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/contestant-badges.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/dawson.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/harvey.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/tv-display.js'), 'utf8'), context);
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

test('Fast Money starts listening without speechstart and resets itself after host audio', async () => {
  const b=browser(async()=>({})), microphones=[];
  b.context.document.querySelector=()=>null;
  b.context.window.SpeechRecognition=class {
    constructor(){microphones.push(this);}
    start(){this.started=true;this.onstart?.();}
    abort(){this.aborted=true;this.onend?.();}
  };
  vm.runInContext("state={code:'TEST',mode:'remote',adminId:'P',phase:'host_wait',turnPlayerId:'P',fastPlayers:['P'],fastIndex:0,fastQuestionIndex:0,inputLocked:true};syncFastMicrophone()",b.context);
  assert.equal(microphones.length,0,'Do not seed recognition with the host announcement');
  vm.runInContext("state.phase='fast_play';state.inputLocked=false;syncFastMicrophone()",b.context);
  const first=microphones[0];assert.equal(first.started,true);assert.equal(first.continuous,true);
  const heard=(mic,words)=>mic.onresult({resultIndex:0,results:[Object.assign([{transcript:words}],{isFinal:true})]});
  heard(first,'coffee'); // Reproduces browsers that do not emit another speechstart.
  assert.equal(vm.runInContext('fastDraft.value',b.context),'coffee');
  vm.runInContext('state.fastQuestionIndex=1;state.inputLocked=true;syncFastMicrophone()',b.context);
  assert.equal(first.aborted,true);
  heard(first,'host words');assert.equal(vm.runInContext('fastDraft.value',b.context),'');
  vm.runInContext('state.inputLocked=false;syncFastMicrophone()',b.context);
  const second=microphones[1];
  heard(first,'late first answer');assert.equal(vm.runInContext('fastDraft.value',b.context),'');
  heard(second,'blue');assert.equal(vm.runInContext('fastDraft.value',b.context),'blue');
  second.onend();await new Promise(resolve=>setTimeout(resolve,280));
  assert.equal(microphones.length,3,'Browser-ended sessions restart automatically');
  vm.runInContext("state.phase='fast_reveal';syncFastMicrophone()",b.context);
  assert.equal(microphones[2].aborted,true);
  assert.equal(vm.runInContext('fastMic',b.context),null);
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

test('Fast Money uses the supplied duplicate and five-answer recordings', () => {
  const b=browser(async()=>({}));
  assert.equal(vm.runInContext("effectAudioSource('fast_duplicate')",b.context),'/assets/fast-money-duplicate.mp3');
  assert.equal(vm.runInContext("effectAudioSource('fast_complete')",b.context),'/assets/fast-money-complete.mp3');
  vm.runInContext("playEffect('fast_duplicate');playEffect('fast_complete')",b.context);
  assert.deepEqual(b.audioInstances.map(a=>a.src),['/assets/fast-money-duplicate.mp3','/assets/fast-money-complete.mp3']);
});

test('the final production card shows the exact Made by Jason logo', () => {
  const b=browser(async()=>({}));
  vm.runInContext("state={families:[{name:'Brown'},{name:'Smith'}],players:[]};closingStage='jason'",b.context);
  const html=vm.runInContext('closingCard()',b.context);
  assert.match(html,/made-by-jason-logo\.png/);
  assert.match(html,/Made by Jason/);
});

test('Fast Money win celebration flashes ten thousand dollars with balloons and confetti', () => {
  const b=browser(async()=>({}));
  const html=vm.runInContext('celebrationOverlay()',b.context);
  assert.match(html,/\$10,000/);
  assert.equal((html.match(/class="win-balloon"/g)||[]).length,30);
  assert.equal((html.match(/class="win-confetti"/g)||[]).length,48);
});

test('end credits roll host, contestants and generated production companies safely', () => {
  const b=browser(async()=>({}));
  vm.runInContext("state={era:'harvey',families:[{name:'Brown'},{name:'Smith'}],players:[{name:'Pat'},{name:'Sam'}],endCredits:[{role:'CONTESTANT FLIGHTS PROVIDED BY',name:'Good Answer Airways'},{role:'SET DESIGN',name:'<Scenic & Co>'}]};closingStage='credits'",b.context);
  const html=vm.runInContext('closingCard()',b.context);
  assert.match(html,/STEVE HARVEY/);
  assert.match(html,/Good Answer Airways/);
  assert.match(html,/&lt;Scenic &amp; Co&gt;/);
  assert.doesNotMatch(html,/<Scenic & Co>/);
});

test('a Fast Money win plays celebration, credits and Made by Jason in order', async () => {
  const b=browser(async()=>({}));
  vm.runInContext("var closingAudio=[];var closingStages=[];playClosingAudio=async src=>closingAudio.push(src);renderGame=()=>closingStages.push(closingStage);state={code:'WIN',mode:'remote',phase:'fast_results',fastScores:[[100,50,25,20,5],[15,null,null,null,null]]}",b.context);
  await vm.runInContext('maybeStartClosingSequence()',b.context);
  assert.equal(vm.runInContext("closingAudio.join(',')",b.context),'/assets/fast-money-celebration.mp3,/assets/fast-money-end-credits.mp3,/assets/made-by-jason.mp3');
  assert.equal(vm.runInContext("closingStages.join(',')",b.context),'celebration,credits,jason,done');
});

test('family announcements and oval reveals finish one family before introducing the other', async () => {
  const b=browser(async()=>({})), scenes=[], stages=[];
  const content={set innerHTML(value){scenes.push(value);},querySelector(){return {classList:{add(){stages.push('slide');}}};}};
  b.context.document.querySelector=selector=>selector==='#introContent'?content:null;
  b.context.setTimeout=fn=>{fn();return 1;};
  b.context.stages=stages;
  vm.runInContext("state={code:'TEST',mode:'remote',phase:'intro',adminId:'P',players:[{id:'P',name:'Pat',photo:'a'},{id:'Q',name:'Sam',photo:'b'}],families:[{name:'Brown',playerIds:['P']},{name:'Smith',playerIds:['Q']}],kissStatus:'off'};playAudioFile=async()=>{};playFamilyAnnouncement=async(i,part)=>stages.push(i+':'+part)",b.context);
  await vm.runInContext('runIntro()',b.context);
  assert.deepEqual(stages,['0:name','slide','0:members','1:name','slide','1:members']);
  assert.match(scenes[0],/Brown/);assert.doesNotMatch(scenes[0],/Smith/);
  assert.match(scenes[1],/Smith/);assert.doesNotMatch(scenes[1],/Brown/);
  assert.equal(b.events.at(-1).name,'introComplete');
});

test('long family names shrink to the measured available width',()=>{
  const b=browser(async()=>({}));
  const label={parentElement:{clientWidth:500},scrollWidth:1000,style:{}};
  b.context.document.querySelector=()=>label;b.context.getComputedStyle=()=>({fontSize:'100px'});
  vm.runInContext('fitFamilyName()',b.context);assert.equal(label.style.fontSize,'43px');
});
test('Good Answer is available only to teammates who are not giving the answer',()=>{
  const b=browser(async()=>({}));
  vm.runInContext("state={phase:'answer',turnPlayerId:'Q',families:[{playerIds:['P','Q']},{playerIds:['R']}]}",b.context);
  assert.match(vm.runInContext('goodAnswerControl()',b.context),/Good Answer/);
  vm.runInContext("myPlayerId='Q'",b.context);assert.equal(vm.runInContext('goodAnswerControl()',b.context),'');
  vm.runInContext("myPlayerId='R'",b.context);assert.equal(vm.runInContext('goodAnswerControl()',b.context),'');
});

test('podium lights follow the first buzz through handoffs and reset for a new faceoff',()=>{
  const b=browser(async()=>({}));
  vm.runInContext("state={families:[{name:'Brown',playerIds:['P','R']},{name:'Smith',playerIds:['Q','S']}],turnPlayerId:null,faceoff:{buzzedBy:null,players:['P','Q']}}",b.context);
  assert.doesNotMatch(vm.runInContext('faceoffPodiumLights()',b.context),/panel lit/);
  for(const [id,side] of [['P',0],['Q',1]]){
    b.context.winner=id;vm.runInContext('state.faceoff.buzzedBy=winner',b.context);
    const lights=vm.runInContext('faceoffPodiumLights()',b.context);
    assert.match(lights,new RegExp(`panel lit" data-podium-side="${side}"`));
    assert.equal((lights.match(/panel lit/g)||[]).length,1);
    vm.runInContext("state.turnPlayerId='S';state.faceoff.players=['R','S']",b.context);
    assert.equal(vm.runInContext('faceoffPodiumLights()',b.context),lights,'Changing answerer must not move the first-buzz lamp');
  }
  vm.runInContext('state.faceoff.buzzedBy=null',b.context);
  assert.doesNotMatch(vm.runInContext('faceoffPodiumLights()',b.context),/panel lit/);
});

test('both eras use cleaned recordings for every recorded sound effect',()=>{
  const b=browser(async()=>({}));
  b.handlers.cue({sound:'buzz'});
  assert.equal(b.audioInstances.length,1);
  assert.equal(b.audioInstances[0].src,'/assets/dawson-faceoff-buzzer-clean.mp3');
  for(const era of ['dawson','harvey']){
    vm.runInContext(`state.era='${era}'`,b.context);
    for(const [type,name] of Object.entries({ding:'answer-ding',strike:'strike-buzzer',buzz:'faceoff-buzzer'})){
      vm.runInContext(`playEffect('${type}')`,b.context);
      const expected=`/assets/dawson-${name}-clean.mp3`;
      assert.equal(b.audioInstances.at(-1).src,expected);
      assert.ok(fs.existsSync(path.join(__dirname,'../public',expected)));
    }
  }
  const before=b.audioInstances.length;
  vm.runInContext("audioEnabled=false;playEffect('ding')",b.context);
  assert.equal(b.audioInstances.length,before,'Muted effects stay muted');
});

for(const era of ['dawson','harvey'])test(`${era} faceoff music starts with invitation playback and stops on completion or cancellation`,async()=>{
  let loaded;
  const b=browser(()=>new Promise(resolve=>loaded=resolve));
  vm.runInContext(`state.era='${era}'`,b.context);
  const playing=vm.runInContext("playHostSpeech('/invite','Come on down',30,'faceoff_walkup')",b.context);
  assert.equal(b.audioInstances.length,0,'No music while host audio is loading');
  loaded({ok:true,status:200,blob:async()=>({})});
  await new Promise(resolve=>setImmediate(resolve));
  const [voice,music]=b.audioInstances;
  const expected=era==='harvey'?'/assets/harvey-faceoff-walkup.mp3':'/assets/faceoff-walkup.mp3';
  assert.equal(music.src,expected);assert.equal(music.volume,.3);
  assert.ok(fs.existsSync(path.join(__dirname,'../public',expected)));
  voice.onplaying();assert.equal(b.audioInstances.length,2,'Buffering must not restart music');
  voice.onended();await playing;assert.equal(music.paused,true);
  const cancelled=vm.runInContext("playHostSpeech('/next','Next players',31,'faceoff_walkup')",b.context);
  loaded({ok:true,status:200,blob:async()=>({})});
  await new Promise(resolve=>setImmediate(resolve));
  const nextMusic=b.audioInstances.at(-1);
  assert.equal(nextMusic.src,expected);
  vm.runInContext('cancelHostCue(31)',b.context);
  await cancelled;assert.equal(nextMusic.paused,true,'Cancelled invitations cannot leave music playing');
});

test('Fast Money cameras show the host, hide the reveal clock, and make room for both answers',()=>{
  const b=browser(async()=>({}));
  vm.runInContext("state={phase:'fast_play',fastIndex:0,fastRevealIndex:null,fastRevealCount:0,fastPlayers:['P','Q'],players:[{id:'P',name:'Pat',photo:'pat.png'},{id:'Q',name:'Sam',photo:'sam.png'}],fastAnswers:[null,null],fastScores:[null,null]}",b.context);
  let html=vm.runInContext('dawsonFastStage()',b.context);
  assert.match(html,/timed-pair/);assert.match(html,/src="\/assets\/dawson-fast-reading.png"/);assert.match(html,/alt="Richard Dawson"/);assert.match(html,/alt="Pat"/);assert.match(html,/data-fast-clock/);
  vm.runInContext("state.phase='fast_reveal';state.fastRevealIndex=0;state.fastAnswers=[['coffee'],null];state.fastScores=[[42],null]",b.context);
  html=vm.runInContext('dawsonFastStage()',b.context);
  assert.match(html,/reveal-pair/);assert.match(html,/fast-reveal-arm/);assert.doesNotMatch(html,/data-fast-clock/);
  vm.runInContext("state.fastIndex=1;state.fastRevealIndex=1;state.fastAnswers[1]=['tea'];state.fastScores[1]=[12]",b.context);
  html=vm.runInContext('dawsonFastStage()',b.context);
  assert.match(html,/coffee/);assert.match(html,/tea/);assert.equal((html.match(/data-fast-slot/g)||[]).length,10);
  assert.doesNotMatch(html,/data-fast-clock|fast-host-pair|<img/);
  vm.runInContext("state.phase='fast_results'",b.context);
  assert.doesNotMatch(vm.runInContext('dawsonFastStage()',b.context),/data-fast-clock|fast-host-pair/);
});

test('only the playing family sees its strike count on phones',()=>{
  const b=browser(async()=>({}));
  vm.runInContext("state={round:0,phase:'answer',controlFamily:0,strikes:2,isSteal:false,families:[{playerIds:['P','Q']},{playerIds:['R']}]}",b.context);
  assert.match(vm.runInContext('phoneStrikes()',b.context),/aria-label="2 of 3 strikes"/);
  for(const change of ["myPlayerId='R'","myPlayerId='P';isDisplay=true","isDisplay=false;state.isSteal=true","state.isSteal=false;state.phase='round_end'","state.phase='host_wait';state.round=-1"]){
    vm.runInContext(change,b.context);assert.equal(vm.runInContext('phoneStrikes()',b.context),'');
  }
});

test('ordinary round and Fast Money reveal endings do not require a continue button',()=>{
  const b=browser(async()=>({}));
  vm.runInContext("state={phase:'round_end',adminId:'P',fastSelectorId:'P',fastPlayers:['P','Q']}",b.context);
  assert.doesNotMatch(vm.runInContext('controls()',b.context),/<button/);
  vm.runInContext("state.phase='fast_reveal_done'",b.context);
  assert.doesNotMatch(vm.runInContext('controls()',b.context),/<button/);
});

test('a duplicate retry clears the old transcript and starts a fresh microphone session',()=>{
  const b=browser(async()=>({})),microphones=[];
  b.context.document.querySelector=()=>null;
  b.context.window.SpeechRecognition=class{constructor(){microphones.push(this)}start(){}abort(){this.aborted=true}};
  vm.runInContext("state={code:'TEST',phase:'fast_play',turnPlayerId:'P',fastPlayers:['Q','P'],fastIndex:1,fastQuestionIndex:0,fastAttempt:0,inputLocked:false};syncFastMicrophone();fastDraft.value='coffee';state.inputLocked=true;state.fastAttempt=1;syncFastMicrophone()",b.context);
  assert.equal(vm.runInContext('fastDraft.value',b.context),'');assert.equal(microphones[0].aborted,true);
  vm.runInContext('state.inputLocked=false;syncFastMicrophone()',b.context);
  assert.equal(microphones.length,2);
  microphones[0].onresult({resultIndex:0,results:[[{transcript:'old coffee'}]]});
  assert.equal(vm.runInContext('fastDraft.value',b.context),'');
  microphones[1].onresult({resultIndex:0,results:[[{transcript:'tea'}]]});
  assert.equal(vm.runInContext('fastDraft.value',b.context),'tea');
});

test('Harvey recording introduces Steve once, followed directly by families',async()=>{
  const requests=[];
  const b=browser(async url=>{requests.push(url);return {status:204}}),events=[],scenes=[];
  b.context.events=events;
  b.context.document.querySelector=selector=>selector==='#introContent'?{set innerHTML(value){scenes.push(value)}}:null;
  b.context.setTimeout=fn=>{fn();return 1};
  vm.runInContext("state={era:'harvey',code:'TEST',phase:'intro',mode:'remote',adminId:'P',players:[{id:'P',name:'Pat',photo:'a'},{id:'Q',name:'Sam',photo:'b'}],families:[{name:'Brown',playerIds:['P']},{name:'Smith',playerIds:['Q']}]};playAudioFile=async src=>events.push(src);speakAsync=async text=>events.push(text);playFamilyAnnouncement=async(i,part)=>events.push(i+':'+part)",b.context);
  await vm.runInContext('runIntro()',b.context);
  assert.deepEqual(events,['/assets/harvey-intro.mp3','0:name','0:members','1:name','1:members']);
  assert.deepEqual(requests,[], 'No redundant host TTS download');
  assert.match(scenes[0],/STEVE/);assert.match(scenes[1],/Brown/);assert.match(scenes[2],/Smith/);
  assert.doesNotMatch(scenes.join(''),/Richard|Dawson|kiss|family-name-door/);
  assert.equal(b.events.at(-1).name,'introComplete');
});

test('board labels shrink to fit and recover full size after a wider resize',()=>{
  const b=browser(async()=>({}));
  const label={textContent:'COMFY FURNITURE',style:{fontSize:''},clientWidth:100,parentElement:{clientHeight:40}};
  const short={textContent:'SUN',style:{fontSize:''},clientWidth:100,parentElement:{clientHeight:40},scrollWidth:100};
  Object.defineProperty(label,'scrollWidth',{get(){return Math.max(this.clientWidth,8+200*(parseFloat(this.style.fontSize)||20)/20)}});
  b.context.document.querySelectorAll=()=>[label,short];
  b.context.getComputedStyle=element=>({fontSize:element.style.fontSize||'20px',paddingLeft:'4px',paddingRight:'4px'});
  vm.runInContext('fitBoardLabels()',b.context);
  assert.ok(label.scrollWidth<=label.clientWidth);
  assert.equal(label.textContent,'COMFY FURNITURE');
  assert.equal(short.style.fontSize,'');
  label.clientWidth=240;
  vm.runInContext('fitBoardLabels()',b.context);
  assert.equal(label.style.fontSize,'','Reset font size when the board grows');
});

test('both eras put escaped contestant names on portrait badges in every camera',()=>{
  const b=browser(async()=>({}));
  vm.runInContext(`state={phase:'fast_play',round:0,bank:0,scores:[0,0],turnPlayerId:'P',
    players:[{id:'P',name:'Pat & Sam <3',photo:'portrait.png'},{id:'Q',name:'Alex',photo:'other.png'}],
    families:[{name:'Brown',playerIds:['P']},{name:'Smith',playerIds:['Q']}],
    faceoff:{players:['P','Q'],buzzedBy:null},fastIndex:0,fastPlayers:['P','Q'],
    fastAnswers:[null,null],fastScores:[null,null]}`,b.context);
  for(const era of ['dawson','harvey']){
    const calls=era==='dawson'
      ? ['dawsonTeam(0)','dawsonFamilyIntroduction(state.families[0])','dawsonFaceoff()',
         'fastHostAndContestant(state.players[0],false)','fastHostAndContestant(state.players[0],true)']
      : ['harveyFamily(0)','harveyFamilyIntroduction(state.families[0])','harveyFaceoff()','harveyFastStage()'];
    for(const call of calls){
      const html=vm.runInContext(call,b.context);
      assert.match(html,new RegExp(`contestant-portrait[^]*<img[^]*contestant-name-badge badge-${era}`));
      assert.match(html,/<text[^>]*>Pat &amp; Sam &lt;3<\/text>/);
      assert.doesNotMatch(html,/<(?:strong|span)>Pat/,'Old name strip is gone');
    }
  }
});

test('long badge names fit inside the oval without clipping or shortening their text',()=>{
  const b=browser(async()=>({}));
  const attrs={};
  const label={textContent:'ALEXANDRA-JOSEPHINE',getComputedTextLength:()=>280,
    removeAttribute:key=>delete attrs[key],setAttribute:(key,value)=>attrs[key]=value};
  b.context.document.querySelectorAll=()=>[label];
  vm.runInContext('fitContestantBadges()',b.context);
  assert.deepEqual(attrs,{textLength:'158',lengthAdjust:'spacingAndGlyphs'});
  assert.equal(label.textContent,'ALEXANDRA-JOSEPHINE');
  label.getComputedTextLength=()=>70;
  vm.runInContext('fitContestantBadges()',b.context);
  assert.deepEqual(attrs,{},'Short names retain natural lettering');
});

test('TV frame fits 720p, 1080p, 4K and a browser window with chrome without distortion',()=>{
  const b=browser(async()=>({}));
  for(const [width,height] of [[1280,720],[1920,1080],[3840,2160],[1920,950],[2560,1080]]){
    const scale=vm.runInContext(`tvDisplayScale(${width},${height})`,b.context);
    const renderedWidth=1920*scale,renderedHeight=1080*scale;
    assert.ok(renderedWidth<=width+.001 && renderedHeight<=height+.001,'Entire frame fits');
    assert.ok(Math.abs(renderedWidth-width)<.001 || Math.abs(renderedHeight-height)<.001,'Use the available screen');
    assert.ok(Math.abs(renderedWidth/renderedHeight-16/9)<1e-12);
  }
});

test('TV sizing and fullscreen controls belong only to the shared host display',async()=>{
  const b=browser(async()=>({})),classes={},properties={};let button=null,entered=0,exited=0;
  const doc=b.context.document;
  doc.body={classList:{toggle:(name,on)=>classes[name]=on},append:element=>button=element};
  doc.documentElement={style:{setProperty:(key,value)=>properties[key]=value,removeProperty:key=>delete properties[key]},
    requestFullscreen:async()=>{entered++;doc.fullscreenElement=doc.documentElement}};
  doc.exitFullscreen=async()=>{exited++;doc.fullscreenElement=null};
  doc.createElement=()=>({remove:()=>button=null});
  doc.querySelector=selector=>selector==='#tvFullscreen'?button:null;
  b.context.window.innerWidth=1280;b.context.window.innerHeight=720;
  vm.runInContext("state.mode='host';isDisplay=true;updateTVDisplay()",b.context);
  assert.equal(classes['tv-display'],true);assert.equal(properties['--tv-scale'],2/3);
  assert.equal(button.textContent,'Full screen');assert.equal(entered,0,'Fullscreen requires a user click');
  await button.onclick();vm.runInContext('updateTVDisplay()',b.context);
  assert.equal(entered,1);assert.equal(button.textContent,'Exit full screen');
  await button.onclick();assert.equal(exited,1);
  vm.runInContext('isDisplay=false;updateTVDisplay()',b.context);
  assert.equal(classes['tv-display'],false);assert.equal(button,null);assert.deepEqual(properties,{});
  vm.runInContext("state.mode='remote';isDisplay=true;updateTVDisplay()",b.context);
  assert.equal(classes['tv-display'],false,'Remote screens retain their own responsive layout');
});

test('Harvey boards preserve answer secrecy and use both columns only for the second reveal',()=>{
  const b=browser(async()=>({}));
  vm.runInContext("state={era:'harvey',phase:'fast_play',fastIndex:0,fastRevealIndex:null,fastRevealCount:0,fastPlayers:['P','Q'],players:[{id:'P',name:'Pat',photo:'pat.png'},{id:'Q',name:'Sam',photo:'sam.png'}],fastAnswers:[null,null],fastScores:[null,null]}",b.context);
  let html=vm.runInContext('harveyFastStage()',b.context);
  assert.match(html,/data-harvey-fast-clock/);assert.match(html,/pat.png/);assert.doesNotMatch(html,/dawson/i);
  vm.runInContext("state.phase='fast_reveal';state.fastRevealIndex=0;state.fastAnswers=[['COFFEE'],null];state.fastScores=[[null],null]",b.context);
  html=vm.runInContext('harveyFastStage()',b.context);assert.match(html,/<span>COFFEE<\/span><b><\/b>/);assert.doesNotMatch(html,/data-harvey-fast-clock/);
  vm.runInContext("state.fastIndex=1;state.fastRevealIndex=1;state.fastAnswers[1]=['TEA'];state.fastScores[1]=[12]",b.context);
  html=vm.runInContext('harveyFastStage()',b.context);assert.match(html,/COFFEE/);assert.match(html,/TEA/);assert.doesNotMatch(html,/<img|data-harvey-fast-clock/);
  assert.equal((html.match(/data-fast-slot/g)||[]).length,10);
  html=vm.runInContext("harveyBoard({answers:[{text:'KEYS',points:31},...Array.from({length:6},()=>({text:null}))]})",b.context);
  assert.equal((html.match(/data-board-slot/g)||[]).length,8);assert.match(html,/data-board-slot="4" style="grid-row:1;grid-column:2"/);
});

test('Harvey podium lights keep the first family lit through answer handoffs',()=>{
  const b=browser(async()=>({}));
  vm.runInContext("state={era:'harvey',families:[{name:'Brown',playerIds:['P']},{name:'Smith',playerIds:['Q']}],faceoff:{buzzedBy:null}}",b.context);
  assert.doesNotMatch(vm.runInContext('harveyPodiumLights()',b.context),/side-\d lit/);
  vm.runInContext("state.faceoff.buzzedBy='Q';state.turnPlayerId='P'",b.context);
  const html=vm.runInContext('harveyPodiumLights()',b.context);assert.match(html,/side-1 lit/);assert.doesNotMatch(html,/side-0 lit/);
});


test('Fast Money offers an empty-answer pass and locks it while the host speaks', () => {
  const b = browser(async () => ({}));
  vm.runInContext("state={phase:'fast_play',fastQuestionIndex:0,fastIndex:1,fastAttempt:2,code:'TEST',inputLocked:false}", b.context);
  assert.match(vm.runInContext('fastForm()', b.context), /type="button" id="fastPass" >Pass/);
  vm.runInContext('passFastQuestion()', b.context);
  assert.equal(b.events.at(-1).name, 'passFastQuestion');
  assert.deepEqual(JSON.parse(JSON.stringify(b.events.at(-1).value)), {code:'TEST',questionIndex:0,fastIndex:1,attempt:2});
  vm.runInContext('state.inputLocked=true', b.context);
  assert.match(vm.runInContext('fastForm()', b.context), /id="fastPass" disabled/);
  const count=b.events.length; vm.runInContext('passFastQuestion()', b.context);
  assert.equal(b.events.length,count);
});

for (const renderer of ['dawsonFastStage','harveyFastStage']) test(`${renderer} retains the first total through second-player preparation and play`, () => {
  const b=browser(async()=>({}));
  vm.runInContext("state={phase:'host_wait',players:[],fastPlayers:[],fastIndex:1,fastFirstTotal:117,fastScores:[[null,null,null,null,null],null],fastAnswers:[null,null]}",b.context);
  for (const phase of ['host_wait','fast_play','fast_judging']) {
    b.context.phase=phase; vm.runInContext('state.phase=phase',b.context);
    assert.match(vm.runInContext(`${renderer}()`,b.context), /(?:aria-label="117"|<b>117<\/b>)/);
  }
});

test('creating or reopening the host display enables sound without a separate toggle', () => {
  const b=browser(async()=>({}));
  vm.runInContext("audioEnabled=false;createRoom('host')",b.context);
  assert.equal(vm.runInContext('audioEnabled',b.context),true);
  vm.runInContext("audioEnabled=false;watchRoom('TEST')",b.context);
  assert.equal(vm.runInContext('shouldHearHost()',b.context),true);
});

test('blocked autoplay waits for a gesture, then resumes the same audio once', async () => {
  const b=browser(async()=>({ok:true,status:200,blob:async()=>({})}));
  let button;
  b.context.document.createElement=()=>button={remove(){}};
  let allowed=false, attempts=0;
  b.context.Audio.prototype.play=function(){attempts++;if(!allowed)return Promise.reject(Object.assign(new Error('gesture required'),{name:'NotAllowedError'}));this.onplaying?.();return Promise.resolve()};
  const playing=vm.runInContext("playHostSpeech('/question','Question',71)",b.context);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(b.events.length,0);assert.equal(button.textContent,'Enable sound');
  assert.equal(vm.runInContext('blockedAudio.size',b.context),1);
  allowed=true;button.onclick();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(attempts,2);assert.equal(b.audioInstances.length,1);
  assert.equal(b.events[0].name,'cueStarted');
  b.audioInstances[0].onended();await playing;
  assert.equal(vm.runInContext('blockedAudio.size',b.context),0);
});

test('blocked intro audio does not finish early, and cancelled blocked host cues cannot replay', async () => {
  const b=browser(async()=>({ok:true,status:200,blob:async()=>({})}));
  b.context.document.createElement=()=>({remove(){}});
  b.context.Audio.prototype.play=()=>Promise.reject(Object.assign(new Error('blocked'),{name:'NotAllowedError'}));
  let finished=false;
  const intro=vm.runInContext("playAudioFile('/intro.mp3')",b.context).then(()=>finished=true);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(finished,false);
  b.context.Audio.prototype.play=function(){this.onended?.();return Promise.resolve()};
  vm.runInContext('unlockAudio()',b.context);await intro;
  b.context.Audio.prototype.play=()=>Promise.reject(Object.assign(new Error('blocked'),{name:'NotAllowedError'}));
  const playing=vm.runInContext("playHostSpeech('/question','Question',72)",b.context);
  await new Promise(resolve=>setImmediate(resolve));
  vm.runInContext('cancelHostCue(72)',b.context);await playing;
  assert.equal(vm.runInContext('blockedAudio.size',b.context),0);
  vm.runInContext('unlockAudio()',b.context);
  assert.equal(b.events.length,0);
});

test('reopening a host screen resumes its pending cue without queuing duplicate playback', async () => {
  const b=browser(async()=>({ok:true,status:200,blob:async()=>({})}));
  vm.runInContext(`socket.emit=(name,value,reply)=>{
    if(name==='watchRoom')reply({ok:true,room:{mode:'host',pendingSpeech:{cueId:80,text:'Welcome back',speechUrl:'/speech',requiresAck:true}}});
  };watchRoom('TEST');watchRoom('TEST')`,b.context);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(b.audioInstances.length,1);
  b.audioInstances[0].onended();
  await vm.runInContext('hostAudioQueue',b.context);
  assert.equal(vm.runInContext('queuedHostCues.size',b.context),0);
});
