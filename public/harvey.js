function isHarvey(){return state?.era === 'harvey';}
function harveyHostCard(){return `<div class="harvey-host-card"><img class="harvey-host-portrait" src="/assets/harvey-intro-portrait.png" alt="Steve Harvey"><div><p>YOUR HOST</p><h1>STEVE<br> HARVEY</h1><span>FAMILY FEUD</span></div></div>`;}
async function runHarveyIntroduction(){
  const content=document.querySelector('#introContent');
  if(content)content.innerHTML=harveyHostCard();
  // Prepare the announcement under the opening music instead of adding a loading pause.
  const announcement=fetch(`/api/room/${state.code}/announcement?part=host`).then(response=>response.ok&&response.status!==204?response.blob():null).catch(()=>null);
  await playAudioFile('/assets/harvey-intro.mp3').catch(()=>{});
  if(state.phase!=='intro')return;
  try{
    const blob=await announcement;
    if(!blob)throw Error('No announcement');
    await playAudioBlob(blob);
  }catch{await speakAsync("And here's your host, Steve Harvey!");}
  for(let index=0;index<state.families.length;index++){
    if(state.phase!=='intro')return;
    if(content)content.innerHTML=harveyFamilyIntroduction(state.families[index]);
    await playFamilyAnnouncement(index,'name');
    if(state.phase!=='intro')return;
    await playFamilyAnnouncement(index,'members');
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
}
function harveyFamilyIntroduction(family){
  return `<section class="harvey-family-intro"><header><span>MEET THE FAMILY</span><h1>${escapeHtml(family.name)}</h1></header><div class="harvey-intro-lineup">${family.playerIds.map(id=>{const p=state.players.find(p=>p.id===id);return `<article><img src="${escapeHtml(p.photo)}" alt="${escapeHtml(p.name)}"><strong>${escapeHtml(p.name)}</strong></article>`}).join('')}</div><div class="harvey-intro-rail">FAMILY FEUD</div></section>`;
}
function harveyBoard(round){
  return `<div class="harvey-board">${Array.from({length:8},(_,i)=>{
    const a=round.answers[i];
    return `<div class="harvey-slot ${a?.text?'revealed':'covered'} ${a?'':'unused'}" data-board-slot="${i}" style="grid-row:${i%4+1};grid-column:${Math.floor(i/4)+1}" title="${escapeHtml(a?.text||'')}">${a?.text?`<span>${escapeHtml(a.text)}</span><b>${a.points}</b>`:a?`<i>${i+1}</i>`:''}</div>`;
  }).join('')}</div>`;
}
function harveyFamily(index){
  const f=state.families[index];
  return `<section class="harvey-family harvey-family-${index}"><div class="harvey-players">${f.playerIds.map(id=>{const p=state.players.find(p=>p.id===id);return `<article class="${id===state.turnPlayerId?'active':''}"><img src="${escapeHtml(p.photo)}" alt="${escapeHtml(p.name)}"><span>${escapeHtml(p.name)}</span></article>`}).join('')}</div><div class="harvey-family-podium"><strong>${escapeHtml(f.name)}</strong><b>${state.scores[index]}</b></div></section>`;
}
function harveyStage(round){
  return `<section class="harvey-stage" aria-label="Steve Harvey era Family Feud stage"><div class="harvey-round">${state.round===4?'SUDDEN DEATH':`ROUND ${state.round+1}`}</div><div class="harvey-board-wrap"><div class="harvey-bank" aria-label="Round bank">${state.bank}</div>${harveyBoard(round)}<div class="harvey-multiplier">${state.round===2?'DOUBLE POINTS':state.round>=3?'TRIPLE POINTS':'FAMILY FEUD'}</div></div>${harveyFamily(0)}${harveyFamily(1)}</section>`;
}
function harveyPodiumLights(){
  const winner=state.faceoff.buzzedBy?state.families.findIndex(f=>f.playerIds.includes(state.faceoff.buzzedBy)):-1;
  return [0,1].map(side=>`<div class="harvey-podium-lights side-${side} ${side===winner?'lit':''}" data-podium-side="${side}" aria-label="${escapeHtml(state.families[side].name)} ${side===winner?'buzzed first':'buzzer waiting'}">${'<i></i>'.repeat(16)}</div>`).join('');
}
function harveyFaceoff(){
  return `<section class="harvey-faceoff" aria-label="Steve Harvey faceoff podium"><div class="harvey-round">${state.round===4?'SUDDEN DEATH':`ROUND ${state.round+1}`} · FACE-OFF</div>${state.faceoff.players.map((id,side)=>{const p=state.players.find(p=>p.id===id);return `<article class="harvey-faceoff-player side-${side} ${state.turnPlayerId===id?'active':''}"><img src="${escapeHtml(p.photo)}" alt="${escapeHtml(p.name)}"><strong>${escapeHtml(p.name)}</strong></article>`}).join('')}${harveyPodiumLights()}</section>`;
}
function harveyFastStage(){
  const reveal=['fast_reveal','fast_reveal_done','fast_results'].includes(state.phase);
  const idx=(reveal?state.fastRevealIndex:state.fastIndex)??0;
  const both=reveal&&(idx===1||state.phase==='fast_results');
  const p=state.players.find(p=>p.id===state.fastPlayers[idx]);
  const total=state.fastScores.flat().reduce((a,b)=>a+(Number(b)||0),0);
  const rows=column=>Array.from({length:5},(_,i)=>{
    const answer=state.fastAnswers[column]?.[i],points=state.fastScores[column]?.[i];
    return `<div class="harvey-fast-row" data-fast-slot="${column}-${i}"><span>${reveal&&answer!=null?escapeHtml(answer||'NO ANSWER'):''}</span><b>${reveal&&points!=null?points:''}</b></div>`;
  }).join('');
  const remaining=state.fastDeadline?Math.max(0,Math.ceil((state.fastDeadline-serverTime())/1000)):state.fastIndex===1?60:45;
  const clock=!!p&&['fast_play','host_wait'].includes(state.phase);
  const top=reveal&&idx===1&&state.fastRevealCount?state.fastTopAnswers?.[state.fastRevealCount-1]:null;
  return `<section class="harvey-fast-shell" aria-label="Steve Harvey era Fast Money"><h1>FAST MONEY</h1><div class="harvey-fast-columns"><div>${rows(0)}</div><div>${both?rows(1):p?`<div class="harvey-fast-portrait"><img src="${escapeHtml(p.photo)}" alt="${escapeHtml(p.name)}"><strong>${escapeHtml(p.name)}</strong></div>`:'<div class="harvey-fast-welcome">Who will play<br>FAST MONEY?</div>'}</div></div><div class="harvey-fast-total">TOTAL <b>${total}</b></div>${clock?`<div class="harvey-fast-clock" data-harvey-fast-clock>${remaining}</div>`:''}${top?`<div class="harvey-fast-top">NUMBER ONE: ${escapeHtml(top)}</div>`:''}${state.phase==='fast_results'?`<div class="harvey-payout">${total>=200?'$10,000':'$'+Number(state.fastPrize||0).toLocaleString()} WON!</div>`:''}</section>`;
}
