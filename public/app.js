const socket = io();
const app = document.querySelector('#app');
let state = null, roomCode = null, myPlayerId = null, isDisplay = false, introRun = false, fastTimer = null, audioEnabled = false, serverOffset = 0;
let hostAudioQueue = Promise.resolve(), activeRecognition = null, activeHostPlayback = null, cancelledCues = new Set(), clockInterval = null;
let fastMic = null, fastMicSession = null, fastMicMuted = false, fastMicError = '', fastMicRestart = null, fastDraft = { key: null, value: '' };
let session = JSON.parse(localStorage.getItem('feudSession') || 'null');

const pathBits = location.pathname.split('/').filter(Boolean);
if (pathBits[0] === 'join' && pathBits[1]) showJoin(pathBits[1].toUpperCase());
else if (pathBits[0] === 'host' && pathBits[1]) watchRoom(pathBits[1].toUpperCase());
else if (location.search?.includes('test=')) showTestMenu();
else showLanding();

socket.on('connect', () => {
  if (session?.code && session?.playerId && location.pathname.split('/')[1] === 'join' && location.pathname.split('/')[2]?.toUpperCase() === session.code) {
    socket.emit('rejoin', session, result => {
      if (result?.ok) { roomCode = session.code; myPlayerId = result.playerId; saveSession(); }
    });
  } else if (isDisplay && roomCode) watchRoom(roomCode);
});
socket.on('state', next => { serverOffset = next.serverNow - Date.now(); state = next; roomCode = next.code; render(); });
socket.on('cue', cue => {
  if (cue.sound) playEffect(cue.sound);
  if (cue.speechUrl && shouldHearHost()) {
    hostAudioQueue = hostAudioQueue.then(async () => {
      if (cancelledCues.delete(cue.cueId)) return;
      await playHostSpeech(cue.speechUrl, cue.text, cue.cueId);
      if (cue.requiresAck && isAudioController() && !cancelledCues.has(cue.cueId)) socket.emit('cueFinished', { code: roomCode, cueId: cue.cueId });
    }).catch(() => {});
  }
});
socket.on('cancelCue', ({ cueId }) => cancelHostCue(cueId));
socket.on('answerResult', result => { if (!result.correct) flashStrike(result.count || 1); });
socket.on('boardReveal', result => { playEffect(result.fastIndex != null && result.points === 0 ? 'strike' : 'ding'); requestAnimationFrame(() => document.querySelector(`[data-${result.fastIndex == null ? `board-slot="${result.index}"` : `fast-slot="${result.fastIndex}-${result.index}"`}]`)?.classList.add('flip-now')); });

function showLanding() {
  app.innerHTML = `<main class="page"><section class="landing"><div class="logo"><span>FAMILY<br>FEUD</span></div><p class="tagline">The classic survey game, made for your family.</p><div class="mode-grid"><article class="mode-card"><h2>HOST ON THIS SCREEN</h2><p>Put the board on the TV. Players scan a QR code and use their phones to buzz and answer.</p><button class="primary" id="hostMode">Create TV Game</button></article><article class="mode-card"><h2>REMOTE PLAY</h2><p>Everyone joins by link and sees the complete game on their own screen—perfect for playing apart.</p><button class="primary" id="remoteMode">Create Remote Game</button></article><article class="mode-card test-mode-card"><h2>TEST MODE</h2><p>Try the introduction and first round, or jump straight to Fast Money. No other players needed.</p><button class="primary" id="testMode">Open Test Mode</button></article></div></section></main>`;
  document.querySelector('#hostMode').onclick = () => createRoom('host');
  document.querySelector('#remoteMode').onclick = () => createRoom('remote');
  document.querySelector('#testMode').onclick = showTestMenu;
}

function showTestMenu() {
  app.innerHTML = `<main class="page"><section class="panel test-setup"><h1>TEST MODE</h1><p>Rehearse on your own. Two sample families are provided; you control whichever contestant is up. The normal AI host, judging, five-second guesses, microphone, and reveals stay active.</p><p>Tests use fixed sample surveys so you can repeat the same sequence. They do not affect real games. AI audio, judging, and optional image generation use your configured API.</p><label>Your contestant name <input id="testName" maxlength="24" value="Alex"></label><details><summary>Optional: use your photo and test the introduction souvenir</summary><div class="photo-row"><img class="photo-preview" id="testPreview" alt="Your optional photo"><label class="secondary file-button">Upload your photo<input type="file" id="testPhoto" accept="image/*"></label></div><label class="consent-check"><input type="checkbox" id="testKissConsent"><span>I am 18 or older, this is my photo, and I agree that OpenAI may create an obviously fictional Richard Dawson greeting-kiss souvenir using it. This is optional and only runs in the introduction test.</span></label></details><div class="test-actions"><button class="primary" data-test-part="intro">Test Introduction + Round 1</button><button class="primary" data-test-part="fast">Test Fast Money</button></div><p>Fast Money includes player selection, both timed halves, both reveals, and the final payout.</p><a href="/">Back to regular games</a></section></main>`;
  let photo = '';
  document.querySelector('#testPhoto').onchange = async event => {
    const file = event.target.files[0]; if (!file) return;
    photo = await resizeImage(file); document.querySelector('#testPreview').src = photo;
  };
  document.querySelectorAll('[data-test-part]').forEach(button => button.onclick = () => {
    const part = button.dataset.testPart;
    const kissConsent = part === 'intro' && document.querySelector('#testKissConsent').checked;
    if (kissConsent && !photo) return toast('Upload your own photo to test the souvenir.');
    unlockAudio();
    const buttons = [...document.querySelectorAll('[data-test-part]')]; buttons.forEach(b => b.disabled = true);
    socket.emit('createTestRoom', { part, name: val('#testName'), photo, kissConsent }, result => {
      if (!result?.ok) { buttons.forEach(b => b.disabled = false); return toast(result?.error || 'Could not start the test.'); }
      roomCode = result.code; myPlayerId = result.playerId; isDisplay = false; introRun = false;
      history.replaceState({}, '', `/join/${result.code}`); saveSession();
    });
  });
}

function isTestController() { return !!state?.testPart && state.adminId === myPlayerId; }
function testToolbar() {
  if (!state?.testPart) return '';
  const contestant = state.players.find(p => p.id === state.turnPlayerId);
  return `<nav class="test-toolbar" aria-label="Test controls"><strong>TEST: ${state.testPart === 'intro' ? 'INTRO + ROUND 1' : 'FAST MONEY'}</strong><span>${contestant ? `You control ${escapeHtml(contestant.name)}` : 'You control both families'}</span><a href="/?test=1">Restart / switch test</a><a href="/">Exit test</a></nav>`;
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
  app.innerHTML = `<main class="page"><section class="panel join-wrap"><h1>Join the Family Feud</h1><form class="join-form" id="joinForm"><label>Your name<input id="name" maxlength="24" required autocomplete="name" placeholder="e.g., Jason"></label><div class="photo-row"><img class="photo-preview" id="preview" alt="Your photo"><div class="photo-actions"><button class="secondary" type="button" id="camera">Take a selfie</button><label class="secondary file-button">Upload a photo<input type="file" id="file" accept="image/*"></label></div></div><label>Suggest a family name<input id="family" maxlength="24" required placeholder="e.g., Brown"><small>We’ll add “Family” on the game board.</small></label><label class="consent-check"><input type="checkbox" id="kissConsent"><span>I am 18 or older, this is my photo, and I agree that OpenAI may create an obviously fictional Richard Dawson greeting-kiss souvenir using it.<small>Optional. Your photo remains available for the normal game even if this is unchecked.</small></span></label><button class="primary" type="submit">Join Game</button></form></section></main>`;
  let photo = '';
  document.querySelector('#camera').onclick = async () => { const result = await takeSelfie(); if (result) setPhoto(result); };
  document.querySelector('#file').onchange = async e => { if (e.target.files[0]) setPhoto(await resizeImage(e.target.files[0])); };
  function setPhoto(value) { photo = value; document.querySelector('#preview').src = value; }
  document.querySelector('#joinForm').onsubmit = e => {
    e.preventDefault(); if (!photo) return toast('Please take or upload a photo.'); unlockAudio();
    const submit = e.target.querySelector('[type=submit]'); submit.disabled = true;
    socket.emit('joinRoom', { code, name: val('#name'), familyName: val('#family'), photo, kissConsent: document.querySelector('#kissConsent').checked }, result => {
      submit.disabled = false; if (!result?.ok) return toast(result.error);
      myPlayerId = result.playerId; saveSession();
    });
  };
}

function render() {
  if (!state) return; clearInterval(clockInterval);
  syncFastMicrophone();
  if (state.testPart && state.phase === 'generating') {
    app.innerHTML = `${testToolbar()}<main class="page"><section class="panel"><h1>Preparing your test…</h1><p>${state.kissStatus === 'preparing' ? 'Creating your optional souvenir. This can take up to 90 seconds.' : 'Setting up the sample families.'}</p></section></main>`; return;
  }
  if (state.phase === 'lobby' || state.phase === 'generating') return renderLobby();
  if (state.phase === 'intro') return renderIntro();
  if (state.phase === 'faceoff' && state.mode === 'host' && state.faceoff?.players.includes(myPlayerId) && !isDisplay) return renderFaceoffBuzzer();
  renderGame();
}

function renderLobby() {
  const joined = state.players.some(p => p.id === myPlayerId);
  if (!joined && !isDisplay && pathBits[0] === 'join') return;
  const admin = state.adminId === myPlayerId;
  const url = `${location.origin}/join/${state.code}`;
  const roster = admin ? `<div class="players">${state.players.map(playerCard).join('') || '<p>No players yet</p>'}</div>` : `<div class="private-lobby"><div class="player-count">${state.players.length}/10</div><p>${isDisplay ? 'Players have joined.' : 'You’re in!'} Only the player who created the game can see the lobby roster.</p></div>`;
  app.innerHTML = `<main class="page"><section class="lobby"><div class="lobby-layout"><article class="panel"><h2>${state.mode === 'host' ? 'SCAN TO JOIN' : 'SHARE THIS GAME'}</h2><div class="join-code">${state.code}</div>${state.mode === 'host' ? `<img class="qr" src="/api/room/${state.code}/qr" alt="Join QR code">` : ''}<p class="share-url">${escapeHtml(url)}</p><button class="secondary" id="share">Share link</button><p><small>The dynamic announcer is an AI-generated voice.</small></p></article><article class="panel"><h1>${state.phase === 'generating' ? 'Preparing the surveys…' : admin ? `Who’s playing? (${state.players.length}/10)` : 'Waiting for the game to start'}</h1>${roster}${admin && state.phase === 'lobby' ? `<p>You’re the first player, so you control the game.</p><button class="primary" id="start" ${state.players.length < 2 ? 'disabled' : ''}>Start the Game</button>${state.players.length < 2 ? '<p><small>At least two players are needed.</small></p>' : ''}` : state.phase === 'lobby' ? '<p>Waiting for the first player to start…</p>' : ''}</article></div></section></main>`;
  document.querySelector('#share').onclick = () => share(url);
  const start = document.querySelector('#start'); if (start) start.onclick = () => { unlockAudio(); socket.emit('startGame', { code: state.code }, r => { if (!r?.ok) toast(r.error); }); };
}

function renderFaceoffBuzzer(){
  const enabled = state.faceoff.canBuzz && !state.faceoff.buzzedBy;
  app.innerHTML = `<main class="faceoff-phone"><button class="buzz" id="buzz" ${enabled ? '' : 'disabled'}>${enabled ? 'BUZZ!' : 'LISTEN'}</button></main>`;
  document.querySelector('#buzz').onclick=()=>{if(enabled){cancelCurrentHost();socket.emit('buzz',{code:state.code})}};
  offerSoundUnlock();
}

function renderIntro() {
  if (introRun && document.querySelector('#introContent')) return;
  app.innerHTML = `${testToolbar()}<section class="intro-overlay"><button class="secondary sound-unlock" id="sound">${audioEnabled ? 'Sound enabled' : 'Enable sound'}</button><div class="intro-content" id="introContent"><h1 class="intro-title">FAMILY<br>FEUD</h1><p class="tagline">${escapeHtml(state.message)}</p></div></section>`;
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
    for (let index = 0; index < state.families.length; index++) {
      if (state.phase !== 'intro') return;
      if (introContent) introContent.innerHTML = dawsonFamilyIntroduction(state.families[index]);
      await playFamilyAnnouncement(index, 'name');
      if (state.phase !== 'intro') return;
      introContent?.querySelector('.family-reveal-window')?.classList.add('open');
      await new Promise(resolve => setTimeout(resolve, 1450));
      await playFamilyAnnouncement(index, 'members');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    const kissed = state.players.find(p => p.id === state.kissPlayerId) || randomPlayer();
    if (introContent) introContent.innerHTML = `<div class="host-card"><img class="host-isolated" src="/assets/richard-dawson-isolated.png" alt="Richard Dawson"><div><h1 class="intro-title">RICHARD<br>DAWSON</h1></div></div>`;
    await playAudioFile('/assets/intro-theme.mp3');
    if (introContent) introContent.innerHTML = state.kissStatus === 'ready' ? `<img class="kiss-souvenir" src="/api/room/${state.code}/kiss" alt="AI-edited Richard Dawson greeting ${escapeHtml(kissed.name)}"><p class="kiss">Richard greeted ${escapeHtml(kissed.name)}! 💋</p><p class="kiss-disclosure">AI-edited fictional souvenir</p>` : `<div class="host-card"><img class="host-isolated" src="/assets/richard-dawson-isolated.png" alt="Richard Dawson"><div><h1 class="intro-title">RICHARD<br>DAWSON</h1><p class="kiss">Richard greeted ${escapeHtml(kissed.name)}! 💋</p></div></div>`;
    await new Promise(resolve => setTimeout(resolve, state.kissStatus === 'ready' ? 3800 : 1200));
    await new Promise(resolve => setTimeout(resolve, 900));
  } finally {
    if (state?.phase === 'intro' && (state.adminId === myPlayerId || isDisplay)) socket.emit('introComplete', { code: state.code });
  }
}

async function playFamilyAnnouncement(index, part){
  const family = state.families[index];
  const fallback = part === 'name' ? `${index ? 'And now, introducing' : 'Introducing'} the ${family.name} family!` : `${names(family)}!`;
  try{const response=await fetch(`/api/room/${state.code}/announcement?family=${index}&part=${part}`);if(!response.ok||response.status===204)throw new Error('No API voice');await playAudioBlob(await response.blob())}
  catch{return speakAsync(fallback)}
}

function playAudioFile(src){return playAudioElement(new Audio(src))}
function playAudioBlob(blob){return playAudioElement(new Audio(URL.createObjectURL(blob)))}
function playAudioElement(audio){return new Promise((resolve,reject)=>{audio.onended=resolve;audio.onerror=reject;audio.play().catch(reject)})}

function renderGame() {
  clearInterval(fastTimer); introRun = false;
  const round = state.round >= 0 ? state.game.rounds[state.round] : null;
  const faceoffScene = showFaceoffScene();
  app.innerHTML = `${testToolbar()}<main class="game-shell ${faceoffScene ? 'faceoff-layout' : ''}"><section class="stage">${faceoffScene ? dawsonFaceoff() : round ? dawsonStage(round) : dawsonFastStage()}</section><div class="status-banner">${escapeHtml(state.message)}</div><section class="controls" id="controls">${controls()}</section></main>`;
  wireControls();
  updateFastMicUI();
  startVisibleClocks();
  offerSoundUnlock();
}

function showFaceoffScene() {
  return !!state.faceoff && state.controlFamily === null && state.faceoff.winnerFamily === null && !state.faceoff.showBoard && ['faceoff', 'host_wait', 'answer'].includes(state.phase);
}

function faceoffBuzzControls() {
  if (state.phase !== 'faceoff' || isDisplay || state.faceoff.buzzedBy) return '';
  const enabled = state.faceoff.canBuzz;
  if (isTestController()) return `<div class="remote-buzzers">${state.faceoff.players.map(id => `<button class="buzz" data-test-buzz="${escapeHtml(id)}" ${enabled ? '' : 'disabled'}><small>${escapeHtml(state.players.find(p => p.id === id).name)}</small>${enabled ? 'BUZZ!' : 'LISTEN'}</button>`).join('')}</div>`;
  if (state.faceoff.players.includes(myPlayerId)) return `<div class="remote-buzzers"><button class="buzz" id="buzz" ${enabled ? '' : 'disabled'}>${enabled ? 'BUZZ!' : 'LISTEN'}</button></div>`;
  return '';
}

function board(round) {
  return `<div class="era-board"><div class="board-inner"><div class="answers">${round.answers.map((a,i)=>a.text ? `<div class="answer-slot"><div class="answer-text">${escapeHtml(a.text)}</div><div class="answer-points">${a.points}</div></div>` : `<div class="answer-slot hidden"><span>${i+1}</span></div>`).join('')}</div></div></div>`;
}

function fastStage() {
  if (state.phase === 'fast_reveal' || state.phase === 'fast_reveal_done') return fastRevealStage();
  if (state.phase === 'fast_results') {
    const rows = state.game.fastMoney.map((q,i)=>`<div class="fast-row"><div class="fast-cell">${escapeHtml(state.fastAnswers[0]?.[i] || '—')}</div><div class="fast-cell fast-point">${state.fastScores[0]?.[i] || 0}</div><div class="fast-cell">${escapeHtml(state.fastAnswers[1]?.[i] || '—')}</div><div class="fast-cell fast-point">${state.fastScores[1]?.[i] || 0}</div></div>`).join('');
    const total = (state.fastScores.flat().filter(Number).reduce((a,b)=>a+b,0));
    return `<div class="panel fast-results"><div class="winner">${total >= 200 ? '$10,000 WIN!' : `$${Number(state.fastPrize || 0).toLocaleString()} WON`}</div><h2>${total} FAST MONEY POINTS</h2>${rows}</div>`;
  }
  return `<div class="era-board"><div class="board-inner"><div class="question">FAST MONEY</div><div class="answers">${state.game.fastMoney.map((q,i)=>`<div class="answer-slot hidden"><span>${i+1}</span></div>`).join('')}</div></div></div>`;
}

function fastRevealStage(){
  const idx=state.fastRevealIndex, contestant=state.players.find(p=>p.id===state.fastPlayers[idx]);
  const shown=state.phase==='fast_reveal_done'?5:state.fastRevealCount;
  const rows=state.game.fastMoney.slice(0,shown).map((q,i)=>`<div class="fm-reveal-row"><div><small>${escapeHtml(q.question)}</small><strong>${escapeHtml(state.fastAnswers[idx]?.[i]||'NO ANSWER')}</strong>${idx===1?`<em>Number one: ${escapeHtml(state.fastTopAnswers?.[i]||'')}</em>`:''}</div><span>${state.fastScores[idx]?.[i]||0}</span></div>`).join('');
  return `<div class="panel fast-results"><div class="winner">${escapeHtml(contestant?.name||'PLAYER')}’S ANSWERS</div>${rows}</div>`;
}

function controls() {
  const mine = state.turnPlayerId === myPlayerId || (isTestController() && !!state.turnPlayerId);
  if (state.phase === 'faceoff') return faceoffBuzzControls() || '<span class="muted">Listen to the host. Faceoff contestants buzz on their own phones.</span>';
  if (state.phase === 'answer' && mine && !state.inputLocked) return `<span class="answer-clock" data-answer-clock>5.0</span><form class="answer-form" id="answerForm"><input id="answer" autocomplete="off" placeholder="Answer now" autofocus required><button class="mic-button" type="button" data-mic="#answer" aria-label="Speak answer">🎤 <span>Speak</span></button><button class="primary" type="submit">Submit</button></form><p class="mic-status" aria-live="polite"></p>`;
  if (state.phase === 'decision' && (state.faceoff.winnerFamily === familyIndex() || isTestController())) return '<div class="decision"><button class="primary" data-choice="play">PLAY</button><button class="secondary" data-choice="pass">PASS</button></div>';
  if (state.testPart && (state.phase === 'round_end' || state.phase === 'fast_results')) return '<p>Test complete.</p><a class="primary" href="/?test=1">Replay or choose another test</a>';
  if (state.phase === 'round_end' && state.adminId === myPlayerId) { const label=state.round<3?'Next Round':state.round===3&&Math.max(...state.scores)<300?'Go to Sudden Death':'Go to Fast Money';return `<button class="primary" id="next">${label}</button>`; }
  if (state.phase === 'fast_select' && state.fastSelectorId === myPlayerId) {
    const winner = state.winnerFamily ?? (state.scores[0] >= state.scores[1] ? 0 : 1);
    return `<form id="fastSelect"><p>Select two players:</p>${state.families[winner].playerIds.map(id=>{const p=state.players.find(x=>x.id===id);return `<label><input type="checkbox" name="fast" value="${id}"> ${escapeHtml(p.name)}</label>`}).join(' ')}<br><br><button class="primary">Start Fast Money</button></form>`;
  }
  if (fastMicEligible()) return fastForm();
  if (state.phase === 'fast_reveal_done' && state.fastSelectorId === myPlayerId) { const same=state.fastPlayers[0]===state.fastPlayers[1];return `<button class="primary" id="continueFast">${state.fastRevealIndex===0?(same?'Play Second Half':`Bring in ${escapeHtml(state.players.find(p=>p.id===state.fastPlayers[1])?.name||'Second Player')}`):'Show Final Result'}</button>`; }
  return '<span class="muted">Follow the game on screen…</span>';
}

function fastForm() {
  const locked = state.inputLocked;
  return `<div class="fast-progress">ANSWER ${state.fastQuestionIndex+1} OF 5${locked ? ' · LISTEN TO THE HOST' : ''}</div><form class="answer-form" id="fastForm"><input id="fastAnswer" autocomplete="off" placeholder="${locked ? 'Listen to the host…' : 'Type or speak your answer'}" ${locked ? 'disabled' : ''} required><button class="mic-button" type="button" id="fastMicToggle" aria-label="Toggle Fast Money microphone">🎤 <span>Mic on</span></button><button class="primary" type="submit" ${locked ? 'disabled' : ''}>Submit</button></form><p class="mic-status" aria-live="polite"></p>`;
}

function wireControls() {
  document.querySelector('#buzz')?.addEventListener('click', () => { if (state.faceoff.canBuzz) { cancelCurrentHost(); socket.emit('buzz', { code: state.code }); } });
  document.querySelectorAll('[data-test-buzz]').forEach(button => button.onclick = () => { if (state.faceoff.canBuzz) { cancelCurrentHost(); socket.emit('buzz', { code: state.code, playerId: button.dataset.testBuzz }); } });
  document.querySelector('#answerForm')?.addEventListener('submit', e => {
    e.preventDefault(); const answer=val('#answer'); if(!answer) return;
    const button=e.target.querySelector('[type=submit]'); button.disabled=true; button.textContent='OpenAI is judging…';
    socket.emit('submitAnswer',{code:state.code,answer,token:state.answerToken},r=>{if(!r?.ok){toast(r.error);button.disabled=false;button.textContent='Submit'}});
  });
  document.querySelectorAll('[data-mic]').forEach(button => button.addEventListener('click', () => startMicrophone(button.dataset.mic, button)));
  document.querySelectorAll('[data-choice]').forEach(b=>b.onclick=()=>socket.emit('playOrPass',{code:state.code,choice:b.dataset.choice}));
  document.querySelector('#next')?.addEventListener('click',()=>socket.emit('nextRound',{code:state.code}));
  document.querySelector('#fastSelect')?.addEventListener('submit',e=>{e.preventDefault();const ids=[...e.target.querySelectorAll(':checked')].map(x=>x.value);if(ids.length!==2)return toast('Choose exactly two players.');socket.emit('selectFastPlayers',{code:state.code,playerIds:ids});});
  document.querySelector('#fastForm')?.addEventListener('submit',e=>{e.preventDefault();submitFast(e.target);});
  document.querySelector('#fastAnswer')?.addEventListener('input',e=>{fastDraft={key:fastAnswerKey(),value:e.target.value};});
  document.querySelector('#fastMicToggle')?.addEventListener('click',()=>{
    if(fastMicError || fastMicMuted){fastMicMuted=false;fastMicError='';syncFastMicrophone();}
    else {fastMicMuted=true;stopFastMicrophone();}
    updateFastMicUI();
  });
  document.querySelector('#continueFast')?.addEventListener('click',async e=>{e.currentTarget.disabled=true;e.currentTarget.textContent='Finishing the reveal…';await hostAudioQueue;socket.emit('continueFastMoney',{code:state.code});});
}

function submitFast(form) { const answer=form.querySelector('#fastAnswer').value.trim();if(!answer||state.inputLocked)return;const button=form.querySelector('button[type="submit"],button.primary');button.disabled=true;socket.emit('submitFastAnswer',{code:state.code,answer,questionIndex:state.fastQuestionIndex,fastIndex:state.fastIndex},result=>{if(!result?.ok)button.disabled=false}); }
function scoreCard(i,right=false){const f=state.families[i];return `<div class="family-score ${right?'right':''}"><div>${f?`${escapeHtml(f.name)}<br><small>FAMILY</small>`:'FAMILY'}</div><div class="score-number">${state.scores[i]||0}</div></div>`}
function playerCard(p){return `<div class="player-card"><img src="${p.photo}" alt=""><strong>${escapeHtml(p.name)}</strong>${p.connected?'':'<small>Reconnecting…</small>'}</div>`}
function familyPanel(f){return `<article class="family-panel"><h2>${escapeHtml(f.name)} FAMILY</h2><div class="family-list">${f.playerIds.map(id=>playerCard(state.players.find(p=>p.id===id))).join('')}</div></article>`}
function familyIndex(){return state.families.findIndex(f=>f.playerIds.includes(myPlayerId))}
function names(f){return f.playerIds.map(id=>state.players.find(p=>p.id===id)?.name).filter(Boolean).join(', ')}
function randomPlayer(){return state.players[Math.floor(Math.random()*state.players.length)]}
function val(sel){return document.querySelector(sel)?.value.trim()||''}
function saveSession(){session={code:roomCode,playerId:myPlayerId};localStorage.setItem('feudSession',JSON.stringify(session))}
function escapeHtml(v=''){return String(v).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function toast(text){const el=document.querySelector('#toast');el.textContent=text;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),3000)}
function flashStrike(count=1){const el=document.createElement('div');el.className='strike-flash';el.innerHTML=Array.from({length:Math.min(3,count)},()=>`<span class="strike-frame"><svg viewBox="0 0 100 130" aria-hidden="true"><path d="M18 16L82 114M82 16L18 114" stroke="#a92d1e" stroke-width="24" stroke-linecap="square"/></svg></span>`).join('');document.body.append(el);setTimeout(()=>el.remove(),1250)}
async function share(url){try{if(navigator.share)await navigator.share({title:'Join our Family Feud game',url});else{await navigator.clipboard.writeText(url);toast('Join link copied!')}}catch{}}
function unlockAudio(){
  audioEnabled=true;const Ctx=window.AudioContext||window.webkitAudioContext;
  if(Ctx){window.feudAudio=window.feudAudio||new Ctx();window.feudAudio.resume();const oscillator=window.feudAudio.createOscillator(),gain=window.feudAudio.createGain();gain.gain.value=0;oscillator.connect(gain).connect(window.feudAudio.destination);oscillator.start();oscillator.stop(window.feudAudio.currentTime+.01)}
}
function speak(text){if(!('speechSynthesis'in window)||!audioEnabled)return;const u=new SpeechSynthesisUtterance(text);u.rate=.88;u.pitch=.78;u.volume=1;speechSynthesis.speak(u)}
function shouldHearHost(){return audioEnabled&&(isDisplay||state?.mode==='remote')}
function isAudioController(){return state?.mode==='host'?isDisplay:state?.adminId===myPlayerId}
async function playHostSpeech(url,text,cueId){
  const controller=new AbortController(),signal=controller.signal;
  const session={cueId,audio:null,controller};activeHostPlayback=session;
  const started=()=>{if(!signal.aborted&&isAudioController())socket.emit('cueStarted',{code:roomCode,cueId})};
  let objectUrl;
  try{
    const response=await fetch(url,{signal});if(!response.ok||response.status===204)throw new Error('No API audio');
    const blob=await response.blob();if(signal.aborted)return;
    objectUrl=URL.createObjectURL(blob);const audio=new Audio(objectUrl);session.audio=audio;
    await new Promise((resolve,reject)=>{
      const aborted=()=>{audio.pause();resolve()};signal.addEventListener('abort',aborted,{once:true});
      audio.onplaying=started;audio.onended=()=>{signal.removeEventListener('abort',aborted);resolve()};audio.onerror=reject;audio.play().catch(reject);
    });
  }catch(error){
    if(!signal.aborted)await speakAsync(text,signal,started);
  }finally{
    if(objectUrl)URL.revokeObjectURL(objectUrl);
    if(activeHostPlayback===session)activeHostPlayback=null;
  }
}
function cancelHostCue(cueId){cancelledCues.add(cueId);if(activeHostPlayback?.cueId===cueId){activeHostPlayback.controller.abort();activeHostPlayback.audio?.pause();if('speechSynthesis'in window)speechSynthesis.cancel()}}
function cancelCurrentHost(){if(activeHostPlayback)cancelHostCue(activeHostPlayback.cueId)}
function speakAsync(text,signal,onStart){return new Promise(resolve=>{if(!('speechSynthesis'in window)||!audioEnabled||signal?.aborted)return resolve();const u=new SpeechSynthesisUtterance(text);u.rate=state?.phase==='fast_play'?1.25:1;u.pitch=.8;const done=()=>{signal?.removeEventListener('abort',aborted);resolve()};const aborted=()=>{speechSynthesis.cancel();done()};signal?.addEventListener('abort',aborted,{once:true});u.onstart=onStart;u.onend=done;u.onerror=done;speechSynthesis.speak(u)})}

function fastMicEligible(){return !isDisplay && !!state?.fastPlayers?.length && state.turnPlayerId===state.fastPlayers[state.fastIndex] && (state.turnPlayerId===myPlayerId||isTestController()) && ['host_wait','fast_play'].includes(state.phase);}
function fastAnswerKey(){return `${state?.code}:${state?.fastIndex}:${state?.fastQuestionIndex}`;}
function acceptingFastSpeech(){return fastMicEligible() && state.phase==='fast_play' && !state.inputLocked && !activeHostPlayback && !fastMicMuted;}
function stopFastMicrophone(){clearTimeout(fastMicRestart);fastMicRestart=null;const mic=fastMic;fastMic=null;mic?.abort();}
function syncFastMicrophone(){
  if(!fastMicEligible()){stopFastMicrophone();fastMicSession=null;return;}
  const sessionKey=`${state.code}:${state.fastIndex}`;
  if(fastMicSession!==sessionKey){stopFastMicrophone();fastMicSession=sessionKey;fastMicMuted=false;fastMicError='';fastDraft={key:null,value:''};}
  if(fastDraft.key!==fastAnswerKey())fastDraft={key:fastAnswerKey(),value:''};
  if(fastMic || fastMicMuted || fastMicError || fastMicRestart)return;
  const Recognition=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!Recognition){fastMicError='Voice input is not supported in this browser. Type your answer instead.';return;}
  activeRecognition?.abort();activeRecognition=null;
  const mic=new Recognition();fastMic=mic;mic.lang='en-CA';mic.continuous=true;mic.interimResults=true;
  let utteranceKey=null;
  mic.onspeechstart=()=>{utteranceKey=acceptingFastSpeech()?fastAnswerKey():null;};
  mic.onresult=event=>{
    if(fastMic!==mic||!acceptingFastSpeech()||utteranceKey!==fastAnswerKey())return;
    let words='';for(let i=event.resultIndex;i<event.results.length;i++)words+=event.results[i][0].transcript;
    if(words.trim()){fastDraft={key:utteranceKey,value:words.trim()};updateFastMicUI();}
  };
  mic.onerror=event=>{
    if(fastMic!==mic)return;
    if(['not-allowed','service-not-allowed','audio-capture'].includes(event.error)){
      fastMicError=event.error==='audio-capture'?'Microphone unavailable. Type your answer or retry the mic.':'Allow microphone access, then tap the mic to retry. You can also type.';
      stopFastMicrophone();
    }
    updateFastMicUI();
  };
  mic.onend=()=>{
    if(fastMic!==mic)return;fastMic=null;
    if(fastMicEligible()&&!fastMicMuted&&!fastMicError)fastMicRestart=setTimeout(()=>{fastMicRestart=null;syncFastMicrophone();updateFastMicUI();},250);
  };
  try{mic.start();}catch{fastMic=null;fastMicError='Tap the mic to enable voice input, or type your answer.';}
}
function updateFastMicUI(){
  const button=document.querySelector('#fastMicToggle');if(!button)return;
  button.classList.toggle('listening',!!fastMic&&!fastMicMuted);button.setAttribute('aria-pressed',String(!!fastMic&&!fastMicMuted));
  button.querySelector('span').textContent=fastMicError?'Retry mic':fastMicMuted?'Mic off':'Mic on';
  const input=document.querySelector('#fastAnswer');if(input&&fastDraft.key===fastAnswerKey())input.value=fastDraft.value;
  const status=document.querySelector('.mic-status');if(status)status.textContent=fastMicError||(fastMicMuted?'Microphone off. Type your answer or tap to turn it on.':state.inputLocked?'Mic stays on. Listen to the host; his words are ignored.':fastDraft.value?'Review your answer, then press Submit.':'Listening… say your answer, then press Submit.');
}
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
function playEffect(type){if(!audioEnabled)return;if(type==='ding'){new Audio('/assets/answer-ding.mp3').play().catch(()=>{});return}const ctx=window.feudAudio||(window.feudAudio=new(window.AudioContext||window.webkitAudioContext)());const now=ctx.currentTime;const tones={buzz:[440,.16],reveal:[660,.12],strike:[120,.42],win:[523,.7],round:[330,.25],fast:[780,.2]}[type]||[440,.1];for(let i=0;i<(type==='win'?4:1);i++){const o=ctx.createOscillator(),g=ctx.createGain();o.connect(g).connect(ctx.destination);o.frequency.value=tones[0]*(type==='win'?1+i*.25:1);g.gain.setValueAtTime(.18,now+i*.12);g.gain.exponentialRampToValueAtTime(.001,now+i*.12+tones[1]);o.start(now+i*.12);o.stop(now+i*.12+tones[1])}}

function serverTime(){return Date.now()+serverOffset}
function offerSoundUnlock(){
  if(audioEnabled||(!isDisplay&&state.mode!=='remote'))return;
  const button=document.createElement('button');button.className='secondary sound-unlock';button.textContent='Enable host audio';app.append(button);
  button.onclick=()=>{unlockAudio();button.remove();const cue=state.pendingSpeech;if(!cue)return;hostAudioQueue=hostAudioQueue.then(async()=>{await playHostSpeech(cue.speechUrl,cue.text,cue.cueId);if(isAudioController()&&!cancelledCues.has(cue.cueId))socket.emit('cueFinished',{code:roomCode,cueId:cue.cueId})})};
}
function startVisibleClocks(){
  clearInterval(clockInterval);
  const tick=()=>{
    const answer=document.querySelector('[data-answer-clock]');if(answer&&state.answerDeadline){const left=Math.max(0,state.answerDeadline-serverTime());answer.textContent=(left/1000).toFixed(1);answer.classList.toggle('urgent',left<2000)}
    const fast=document.querySelector('[data-fast-clock]');if(fast&&state.fastDeadline)fast.innerHTML=dotNumber(Math.max(0,Math.ceil((state.fastDeadline-serverTime())/1000)),2);
  };tick();clockInterval=setInterval(tick,100);
}
async function resizeImage(file){const img=await new Promise((resolve,reject)=>{const i=new Image;i.onload=()=>resolve(i);i.onerror=reject;i.src=URL.createObjectURL(file)});const size=500,c=document.createElement('canvas');c.width=c.height=size;const x=c.getContext('2d'),scale=Math.max(size/img.width,size/img.height),w=img.width*scale,h=img.height*scale;x.drawImage(img,(size-w)/2,(size-h)/2,w,h);return c.toDataURL('image/jpeg',.78)}
async function takeSelfie(){let stream;try{stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user'},audio:false})}catch{return toast('Camera unavailable. Please upload a photo instead.')}return new Promise(resolve=>{const modal=document.createElement('div');modal.className='camera-modal';modal.innerHTML='<div class="camera-box"><video autoplay playsinline></video><button class="primary">Take Photo</button><button class="secondary" data-cancel>Cancel</button></div>';document.body.append(modal);const video=modal.querySelector('video');video.srcObject=stream;const finish=v=>{stream.getTracks().forEach(t=>t.stop());modal.remove();resolve(v)};modal.querySelector('.primary').onclick=()=>{const c=document.createElement('canvas');c.width=c.height=500;const x=c.getContext('2d'),scale=Math.max(500/video.videoWidth,500/video.videoHeight),w=video.videoWidth*scale,h=video.videoHeight*scale;x.translate(500,0);x.scale(-1,1);x.drawImage(video,(500-w)/2,(500-h)/2,w,h);finish(c.toDataURL('image/jpeg',.78))};modal.querySelector('[data-cancel]').onclick=()=>finish(null)})}
