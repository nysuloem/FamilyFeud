const socket = io();
const app = document.querySelector('#app');
let state = null, roomCode = null, myPlayerId = null, isDisplay = false, introRun = false, fastTimer = null, audioEnabled = false;
let hostAudioQueue = Promise.resolve(), activeRecognition = null;
const session = JSON.parse(localStorage.getItem('feudSession') || 'null');

const pathBits = location.pathname.split('/').filter(Boolean);
if (pathBits[0] === 'join' && pathBits[1]) showJoin(pathBits[1].toUpperCase());
else if (pathBits[0] === 'host' && pathBits[1]) watchRoom(pathBits[1].toUpperCase());
else showLanding();

socket.on('connect', () => {
  if (session?.code && session?.playerId && pathBits[0] === 'join') {
    socket.emit('rejoin', session, result => {
      if (result?.ok) { roomCode = session.code; myPlayerId = result.playerId; saveSession(); }
    });
  } else if (isDisplay && roomCode) watchRoom(roomCode);
});
socket.on('state', next => { state = next; roomCode = next.code; render(); });
socket.on('cue', cue => {
  if (cue.sound) playEffect(cue.sound);
  if (cue.speechUrl && shouldHearHost()) hostAudioQueue = hostAudioQueue.then(() => playHostSpeech(cue.speechUrl, cue.text)).catch(() => {});
});

function showLanding() {
  app.innerHTML = `<main class="page"><section class="landing"><div class="logo"><span>FAMILY<br>FEUD</span></div><p class="tagline">The classic survey game, made for your family.</p><div class="mode-grid"><article class="mode-card"><h2>HOST ON THIS SCREEN</h2><p>Put the board on the TV. Players scan a QR code and use their phones to buzz and answer.</p><button class="primary" id="hostMode">Create TV Game</button></article><article class="mode-card"><h2>REMOTE PLAY</h2><p>Everyone joins by link and sees the complete game on their own screen—perfect for playing apart.</p><button class="primary" id="remoteMode">Create Remote Game</button></article></div></section></main>`;
  document.querySelector('#hostMode').onclick = () => createRoom('host');
  document.querySelector('#remoteMode').onclick = () => createRoom('remote');
}

function createRoom(mode) {
  socket.emit('createRoom', { mode }, result => {
    if (!result?.ok) return toast('Could not create the game.');
    if (mode === 'host') { history.replaceState({}, '', `/host/${result.code}`); roomCode = result.code; isDisplay = true; }
    else { location.href = `/join/${result.code}?creator=1`; }
  });
}

function watchRoom(code) {
  roomCode = code; isDisplay = true;
  socket.emit('watchRoom', { code }, result => { if (!result?.ok) toast(result.error || 'Game not found'); });
}

function showJoin(code) {
  roomCode = code;
  if (session?.code === code && session.playerId) {
    app.innerHTML = `<main class="page"><section class="panel"><h2>Rejoining game…</h2></section></main>`; return;
  }
  app.innerHTML = `<main class="page"><section class="panel join-wrap"><h1>Join the Family Feud</h1><form class="join-form" id="joinForm"><label>Your name<input id="name" maxlength="24" required autocomplete="name" placeholder="e.g., Jason"></label><div class="photo-row"><img class="photo-preview" id="preview" alt="Your photo"><div class="photo-actions"><button class="secondary" type="button" id="camera">Take a selfie</button><label class="secondary file-button">Upload a photo<input type="file" id="file" accept="image/*"></label></div></div><label>Suggest a family name<input id="family" maxlength="24" required placeholder="e.g., Brown"><small>We’ll add “Family” on the game board.</small></label><button class="primary" type="submit">Join Game</button></form></section></main>`;
  let photo = '';
  document.querySelector('#camera').onclick = async () => { const result = await takeSelfie(); if (result) setPhoto(result); };
  document.querySelector('#file').onchange = async e => { if (e.target.files[0]) setPhoto(await resizeImage(e.target.files[0])); };
  function setPhoto(value) { photo = value; document.querySelector('#preview').src = value; }
  document.querySelector('#joinForm').onsubmit = e => {
    e.preventDefault(); if (!photo) return toast('Please take or upload a photo.'); unlockAudio();
    const submit = e.target.querySelector('[type=submit]'); submit.disabled = true;
    socket.emit('joinRoom', { code, name: val('#name'), familyName: val('#family'), photo }, result => {
      submit.disabled = false; if (!result?.ok) return toast(result.error);
      myPlayerId = result.playerId; saveSession();
    });
  };
}

function render() {
  if (!state) return;
  if (state.phase === 'lobby' || state.phase === 'generating') return renderLobby();
  if (state.phase === 'intro') return renderIntro();
  renderGame();
}

function renderLobby() {
  const joined = state.players.some(p => p.id === myPlayerId);
  if (!joined && !isDisplay && pathBits[0] === 'join') return;
  const admin = state.adminId === myPlayerId;
  const url = `${location.origin}/join/${state.code}`;
  app.innerHTML = `<main class="page"><section class="lobby"><div class="lobby-layout"><article class="panel"><h2>${state.mode === 'host' ? 'SCAN TO JOIN' : 'SHARE THIS GAME'}</h2><div class="join-code">${state.code}</div>${state.mode === 'host' ? `<img class="qr" src="/api/room/${state.code}/qr" alt="Join QR code">` : ''}<p class="share-url">${escapeHtml(url)}</p><button class="secondary" id="share">Share link</button><p><small>The dynamic announcer is an AI-generated voice.</small></p></article><article class="panel"><h1>${state.phase === 'generating' ? 'Preparing the surveys…' : `Who’s playing? (${state.players.length}/10)`}</h1><div class="players">${state.players.map(playerCard).join('') || '<p>No players yet</p>'}</div>${admin && state.phase === 'lobby' ? `<p>You’re the first player, so you control the game.</p><button class="primary" id="start" ${state.players.length < 2 ? 'disabled' : ''}>Start the Game</button>${state.players.length < 2 ? '<p><small>At least two players are needed.</small></p>' : ''}` : state.phase === 'lobby' ? '<p>Waiting for the first player to start…</p>' : ''}</article></div></section></main>`;
  document.querySelector('#share').onclick = () => share(url);
  const start = document.querySelector('#start'); if (start) start.onclick = () => { unlockAudio(); socket.emit('startGame', { code: state.code }, r => { if (!r?.ok) toast(r.error); }); };
}

function renderIntro() {
  const families = state.families;
  app.innerHTML = `<section class="intro-overlay"><button class="secondary sound-unlock" id="sound">${audioEnabled ? 'Sound enabled' : 'Enable sound'}</button><div class="intro-content" id="introContent"><h1 class="intro-title">FAMILY<br>FEUD</h1><p class="tagline">${escapeHtml(state.message)}</p><div class="family-columns">${families.map(f => familyPanel(f)).join('')}</div></div></section>`;
  document.querySelector('#sound').onclick = () => { unlockAudio(); runIntro(); };
  runIntro();
}

async function runIntro() {
  if (introRun || !state?.families?.length || !audioEnabled) return;
  if (state.mode !== 'remote' && !isDisplay) return;
  introRun = true;
  try {
    // The sequence is deliberate: opening clip, family introductions, then host clip.
    await playAudioFile('/assets/richard-dawson-intro.mp3');
    const introContent = document.querySelector('#introContent');
    if (introContent) introContent.innerHTML = `<h1 class="intro-title">INTRODUCING<br>THE FAMILIES</h1><div class="family-columns">${state.families.map(f => familyPanel(f)).join('')}</div>`;
    await playFamilyAnnouncement();
    const kissed = randomPlayer();
    if (introContent) introContent.innerHTML = `<div class="host-card"><img src="/assets/richard-dawson.jpg" alt="Richard Dawson"><div><h1 class="intro-title">RICHARD<br>DAWSON</h1><p class="kiss">Richard kissed ${escapeHtml(kissed.name)}! 💋</p></div></div>`;
    await playAudioFile('/assets/intro-theme.mp3');
    await new Promise(resolve => setTimeout(resolve, 900));
  } finally {
    if (state?.phase === 'intro' && (state.adminId === myPlayerId || isDisplay)) socket.emit('introComplete', { code: state.code });
  }
}

function fallbackAnnouncement() {
  const first = state.families[0], second = state.families[1];
  return speakAsync(`Introducing the ${first.name} family. ${names(first)}. And now, introducing the ${second.name} family. ${names(second)}.`);
}

async function playFamilyAnnouncement(){
  try{const response=await fetch(`/api/room/${state.code}/announcement`);if(!response.ok||response.status===204)throw new Error('No API voice');await playAudioBlob(await response.blob())}
  catch{return fallbackAnnouncement()}
}

function playAudioFile(src){return playAudioElement(new Audio(src))}
function playAudioBlob(blob){return playAudioElement(new Audio(URL.createObjectURL(blob)))}
function playAudioElement(audio){return new Promise((resolve,reject)=>{audio.onended=resolve;audio.onerror=reject;audio.play().catch(reject)})}

function renderGame() {
  clearInterval(fastTimer); introRun = false;
  const round = state.round >= 0 ? state.game.rounds[state.round] : null;
  const multiplier = state.round < 2 ? 'SINGLE' : state.round === 2 ? 'DOUBLE' : 'TRIPLE';
  app.innerHTML = `<main class="game-shell"><header class="topbar">${scoreCard(0)}<div class="round-pill">${state.round >= 0 ? `ROUND ${state.round + 1} · ${multiplier} POINTS` : 'FAST MONEY'}</div>${scoreCard(1, true)}</header><section class="stage">${round ? board(round) : fastStage()}${state.strikes ? `<div class="strikes">${Array.from({length:state.strikes},()=>'<span class="strike">X</span>').join('')}</div>` : ''}</section><div class="status-banner">${escapeHtml(state.message)}</div><section class="controls" id="controls">${controls()}</section></main>`;
  wireControls();
}

function board(round) {
  return `<div class="era-board"><div class="board-inner"><div class="question">${escapeHtml(round.question)}</div><div class="answers">${round.answers.map((a,i)=>a.text ? `<div class="answer-slot"><div class="answer-text">${escapeHtml(a.text)}</div><div class="answer-points">${a.points}</div></div>` : `<div class="answer-slot hidden"><span>${i+1}</span></div>`).join('')}</div></div></div>`;
}

function fastStage() {
  if (state.phase === 'fast_results') {
    const rows = state.game.fastMoney.map((q,i)=>`<div class="fast-row"><div class="fast-cell">${escapeHtml(state.fastAnswers[0]?.[i] || '—')}</div><div class="fast-cell fast-point">${state.fastScores[0]?.[i] || 0}</div><div class="fast-cell">${escapeHtml(state.fastAnswers[1]?.[i] || '—')}</div><div class="fast-cell fast-point">${state.fastScores[1]?.[i] || 0}</div></div>`).join('');
    const total = (state.fastScores.flat().filter(Number).reduce((a,b)=>a+b,0));
    return `<div class="panel fast-results"><div class="winner">FAST MONEY: ${total} POINTS</div>${rows}</div>`;
  }
  return `<div class="era-board"><div class="board-inner"><div class="question">FAST MONEY</div><div class="answers">${state.game.fastMoney.map((q,i)=>`<div class="answer-slot hidden"><span>${i+1}</span></div>`).join('')}</div></div></div>`;
}

function controls() {
  const mine = state.turnPlayerId === myPlayerId;
  if (state.phase === 'faceoff' && state.faceoff.players.includes(myPlayerId) && !state.faceoff.buzzedBy) return '<button class="buzz" id="buzz">BUZZ!</button>';
  if (state.phase === 'answer' && mine) return `<form class="answer-form" id="answerForm"><input id="answer" autocomplete="off" placeholder="Type your answer or tap the microphone" autofocus required><button class="mic-button" type="button" data-mic="#answer" aria-label="Speak answer">🎤 <span>Speak</span></button><button class="primary" type="submit">Submit</button></form><p class="mic-status" aria-live="polite"></p>`;
  if (state.phase === 'decision' && state.faceoff.winnerFamily === familyIndex()) return '<div class="decision"><button class="primary" data-choice="play">PLAY</button><button class="secondary" data-choice="pass">PASS</button></div>';
  if (state.phase === 'round_end' && state.adminId === myPlayerId) return `<button class="primary" id="next">${state.round < 3 ? 'Next Round' : 'Go to Fast Money'}</button>`;
  if (state.phase === 'fast_select' && state.adminId === myPlayerId) {
    const winner = state.scores[0] >= state.scores[1] ? 0 : 1;
    return `<form id="fastSelect"><p>Select two players:</p>${state.families[winner].playerIds.map(id=>{const p=state.players.find(x=>x.id===id);return `<label><input type="checkbox" name="fast" value="${id}"> ${escapeHtml(p.name)}</label>`}).join(' ')}<br><br><button class="primary">Start Fast Money</button></form>`;
  }
  if (state.phase === 'fast_play' && mine) return fastForm();
  return '<span class="muted">Follow the game on screen…</span>';
}

function fastForm() {
  const seconds = state.fastIndex === 0 ? 45 : 60;
  setTimeout(() => startFastTimer(seconds), 0);
  return `<div class="timer" id="timer">${seconds}</div><form class="fast-grid" id="fastForm">${state.game.fastMoney.map((q,i)=>`<label class="fast-question"><span>${i+1}. ${escapeHtml(q.question)}</span><span class="voice-field"><input name="q${i}" id="fast${i}" autocomplete="off"><button class="mic-button compact" type="button" data-mic="#fast${i}" aria-label="Speak answer ${i+1}">🎤</button></span></label>`).join('')}<p class="mic-status" aria-live="polite"></p><button class="primary">Lock In Answers</button></form>`;
}

function wireControls() {
  document.querySelector('#buzz')?.addEventListener('click', () => socket.emit('buzz', { code: state.code }));
  document.querySelector('#answerForm')?.addEventListener('submit', e => {
    e.preventDefault(); const answer=val('#answer'); if(!answer) return;
    const button=e.target.querySelector('[type=submit]'); button.disabled=true; button.textContent='OpenAI is judging…';
    socket.emit('submitAnswer',{code:state.code,answer},r=>{if(!r?.ok){toast(r.error);button.disabled=false;button.textContent='Submit'}});
  });
  document.querySelectorAll('[data-mic]').forEach(button => button.addEventListener('click', () => startMicrophone(button.dataset.mic, button)));
  document.querySelectorAll('[data-choice]').forEach(b=>b.onclick=()=>socket.emit('playOrPass',{code:state.code,choice:b.dataset.choice}));
  document.querySelector('#next')?.addEventListener('click',()=>socket.emit('nextRound',{code:state.code}));
  document.querySelector('#fastSelect')?.addEventListener('submit',e=>{e.preventDefault();const ids=[...e.target.querySelectorAll(':checked')].map(x=>x.value);if(ids.length!==2)return toast('Choose exactly two players.');socket.emit('selectFastPlayers',{code:state.code,playerIds:ids});});
  document.querySelector('#fastForm')?.addEventListener('submit',e=>{e.preventDefault();submitFast(e.target);});
}

function submitFast(form) { clearInterval(fastTimer); const answers=state.game.fastMoney.map((_,i)=>form.querySelector(`[name=q${i}]`).value); socket.emit('submitFastMoney',{code:state.code,answers}); }
function startFastTimer(seconds) { let left=seconds; const el=document.querySelector('#timer'); fastTimer=setInterval(()=>{left--;if(el)el.textContent=left;if(left<=0){clearInterval(fastTimer);const form=document.querySelector('#fastForm');if(form)submitFast(form)}},1000); }
function scoreCard(i,right=false){const f=state.families[i];return `<div class="family-score ${right?'right':''}"><div>${f?`${escapeHtml(f.name)}<br><small>FAMILY</small>`:'FAMILY'}</div><div class="score-number">${state.scores[i]||0}</div></div>`}
function playerCard(p){return `<div class="player-card"><img src="${p.photo}" alt=""><strong>${escapeHtml(p.name)}</strong><small>${escapeHtml(p.familyName)} Family${p.connected?'':' · reconnecting'}</small></div>`}
function familyPanel(f){return `<article class="family-panel"><h2>${escapeHtml(f.name)} FAMILY</h2><div class="family-list">${f.playerIds.map(id=>playerCard(state.players.find(p=>p.id===id))).join('')}</div></article>`}
function familyIndex(){return state.families.findIndex(f=>f.playerIds.includes(myPlayerId))}
function names(f){return f.playerIds.map(id=>state.players.find(p=>p.id===id)?.name).filter(Boolean).join(', ')}
function randomPlayer(){return state.players[Math.floor(Math.random()*state.players.length)]}
function val(sel){return document.querySelector(sel)?.value.trim()||''}
function saveSession(){localStorage.setItem('feudSession',JSON.stringify({code:roomCode,playerId:myPlayerId}))}
function escapeHtml(v=''){return String(v).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function toast(text){const el=document.querySelector('#toast');el.textContent=text;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),3000)}
async function share(url){try{if(navigator.share)await navigator.share({title:'Join our Family Feud game',url});else{await navigator.clipboard.writeText(url);toast('Join link copied!')}}catch{}}
function unlockAudio(){
  audioEnabled=true;const Ctx=window.AudioContext||window.webkitAudioContext;
  if(Ctx){window.feudAudio=window.feudAudio||new Ctx();window.feudAudio.resume();const oscillator=window.feudAudio.createOscillator(),gain=window.feudAudio.createGain();gain.gain.value=0;oscillator.connect(gain).connect(window.feudAudio.destination);oscillator.start();oscillator.stop(window.feudAudio.currentTime+.01)}
}
function speak(text){if(!('speechSynthesis'in window)||!audioEnabled)return;const u=new SpeechSynthesisUtterance(text);u.rate=.88;u.pitch=.78;u.volume=1;speechSynthesis.speak(u)}
function shouldHearHost(){return audioEnabled&&(isDisplay||state?.mode==='remote')}
async function playHostSpeech(url,text){
  try{const response=await fetch(url);if(!response.ok||response.status===204)throw new Error('No API audio');await playAudioBlob(await response.blob())}
  catch{await speakAsync(text)}
}
function speakAsync(text){return new Promise(resolve=>{if(!('speechSynthesis'in window)||!audioEnabled)return resolve();const u=new SpeechSynthesisUtterance(text);u.rate=.9;u.pitch=.8;u.onend=resolve;u.onerror=resolve;speechSynthesis.speak(u)})}
function startMicrophone(selector,button){
  const Recognition=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!Recognition)return toast('Voice input is not supported in this browser. You can still type your answer.');
  activeRecognition?.abort(); const input=document.querySelector(selector),status=document.querySelector('.mic-status');
  const recognition=new Recognition(); activeRecognition=recognition; recognition.lang='en-CA'; recognition.interimResults=true; recognition.continuous=false;
  button.classList.add('listening'); if(status)status.textContent='Listening… say your answer.';
  recognition.onresult=event=>{let words='';for(let i=event.resultIndex;i<event.results.length;i++)words+=event.results[i][0].transcript;input.value=words.trim();if(event.results[event.results.length-1].isFinal&&status)status.textContent=`Heard: “${input.value}” — review it, then submit when ready.`};
  recognition.onerror=event=>{if(status)status.textContent=event.error==='not-allowed'?'Microphone permission was not granted. You can type instead.':'I could not hear that clearly. Tap the microphone to try again.'};
  recognition.onend=()=>{button.classList.remove('listening');activeRecognition=null;if(status&&!input.value)status.textContent='Tap the microphone and speak, or type your answer.'};
  recognition.start();
}
function playEffect(type){if(!audioEnabled)return;const ctx=window.feudAudio||(window.feudAudio=new(window.AudioContext||window.webkitAudioContext)());const now=ctx.currentTime;const tones={buzz:[440,.16],reveal:[660,.12],strike:[120,.42],win:[523,.7],round:[330,.25],fast:[780,.2]}[type]||[440,.1];for(let i=0;i<(type==='win'?4:1);i++){const o=ctx.createOscillator(),g=ctx.createGain();o.connect(g).connect(ctx.destination);o.frequency.value=tones[0]*(type==='win'?1+i*.25:1);g.gain.setValueAtTime(.18,now+i*.12);g.gain.exponentialRampToValueAtTime(.001,now+i*.12+tones[1]);o.start(now+i*.12);o.stop(now+i*.12+tones[1])}}
async function resizeImage(file){const img=await new Promise((resolve,reject)=>{const i=new Image;i.onload=()=>resolve(i);i.onerror=reject;i.src=URL.createObjectURL(file)});const size=500,c=document.createElement('canvas');c.width=c.height=size;const x=c.getContext('2d'),scale=Math.max(size/img.width,size/img.height),w=img.width*scale,h=img.height*scale;x.drawImage(img,(size-w)/2,(size-h)/2,w,h);return c.toDataURL('image/jpeg',.78)}
async function takeSelfie(){let stream;try{stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user'},audio:false})}catch{return toast('Camera unavailable. Please upload a photo instead.')}return new Promise(resolve=>{const modal=document.createElement('div');modal.className='camera-modal';modal.innerHTML='<div class="camera-box"><video autoplay playsinline></video><button class="primary">Take Photo</button><button class="secondary" data-cancel>Cancel</button></div>';document.body.append(modal);const video=modal.querySelector('video');video.srcObject=stream;const finish=v=>{stream.getTracks().forEach(t=>t.stop());modal.remove();resolve(v)};modal.querySelector('.primary').onclick=()=>{const c=document.createElement('canvas');c.width=c.height=500;const x=c.getContext('2d'),scale=Math.max(500/video.videoWidth,500/video.videoHeight),w=video.videoWidth*scale,h=video.videoHeight*scale;x.translate(500,0);x.scale(-1,1);x.drawImage(video,(500-w)/2,(500-h)/2,w,h);finish(c.toDataURL('image/jpeg',.78))};modal.querySelector('[data-cancel]').onclick=()=>finish(null)})}
