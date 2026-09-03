// Functional display geometry follows the supplied Dawson-era TV references.
const DOT_DIGITS = ['111101101101111','010110010010111','111001111100111','111001111001111','101101111001001','111100111001111','111100111101111','111001001001001','111101111101111','111101111001111'];
function dotNumber(value, places = 3) {
  const text = String(Math.max(0, Math.floor(Number(value) || 0))).padStart(places, ' ');
  const dots = [...text].map((char, digit) => [...(DOT_DIGITS[Number(char)] || '000000000000000')].map((lit, i) => `<circle cx="${digit * 24 + (i % 3) * 6 + 4}" cy="${Math.floor(i / 3) * 6 + 4}" r="2.25" fill="${char !== ' ' && lit === '1' ? '#fff6be' : '#272319'}"/>`).join('')).join('');
  return `<svg class="dot-number" viewBox="0 0 ${text.length * 24} 32" role="img" aria-label="${Number(value) || 0}">${dots}</svg>`;
}

function dawsonBoard(round) {
  const slots = Array.from({ length: 8 }, (_, index) => {
    const answer = round.answers[index];
    const row = index % 4 + 1, column = Math.floor(index / 4) + 1;
    return `<div class="dawson-slot ${answer?.text ? 'revealed' : 'covered'} ${answer ? '' : 'unused'}" data-board-slot="${index}" style="grid-row:${row};grid-column:${column}" title="${escapeHtml(answer?.text || '')}">${answer?.text ? `<span class="dawson-label">${escapeHtml(answer.text)}</span><span class="dawson-points">${answer.points}</span>` : answer ? `<span class="cover-number">${index + 1}</span>` : ''}</div>`;
  }).join('');
  const multiplier = state.round === 2 ? 'DOUBLE' : state.round >= 3 ? 'TRIPLE' : '';
  return `<div class="dawson-board"><div class="board-rail">${multiplier || 'SURVEY'}</div><div class="dawson-slots">${slots}</div><div class="board-rail">${multiplier || 'SAYS'}</div></div>`;
}

function dawsonTeam(index) {
  const family = state.families[index];
  return `<section class="stage-family family-${index}" aria-label="${escapeHtml(family.name)} family"><div class="stage-contestants">${family.playerIds.map(id => {
    const p = state.players.find(x => x.id === id);
    return `<div class="stage-player ${state.turnPlayerId === id ? 'active' : ''}">${contestantPortrait(p, 'dawson')}</div>`;
  }).join('')}</div><div class="stage-podium">${escapeHtml(family.name)}<small>FAMILY</small></div></section>`;
}

function dawsonStage(round) {
  return `<section class="dawson-stage" aria-label="Richard Dawson era Family Feud stage"><div class="stage-round">${state.round === 4 ? 'SUDDEN DEATH' : `ROUND ${state.round + 1}`}</div><div class="dawson-oval"><div class="bank-display" aria-label="Round bank">${dotNumber(state.bank)}</div>${dawsonBoard(round)}<div class="score-wing wing-left" aria-label="${escapeHtml(state.families[0].name)} score">${dotNumber(state.scores[0])}</div><div class="score-wing wing-right" aria-label="${escapeHtml(state.families[1].name)} score">${dotNumber(state.scores[1])}</div></div>${dawsonTeam(0)}${dawsonTeam(1)}</section>`;
}

function dawsonFaceoff() {
  const contestants = state.faceoff.players.map((id, side) => {
    const p = state.players.find(p => p.id === id);
    const family = state.families.find(f => f.playerIds.includes(id));
    return `<article class="faceoff-contestant faceoff-side-${side} ${state.turnPlayerId === id ? 'active' : ''}">${contestantPortrait(p, 'dawson')}<span>${escapeHtml(family.name)} FAMILY</span></article>`;
  }).join('');
  return `<section class="dawson-faceoff" aria-label="Richard Dawson faceoff podium"><div class="stage-round">${state.round === 4 ? 'SUDDEN DEATH' : `ROUND ${state.round + 1}`} · FACE-OFF</div>${faceoffPodiumLights()}${contestants}${state.faceoff.buzzedBy ? '' : '<div class="faceoff-podium-label">FAMILY FEUD</div>'}</section>`;
}

function faceoffPodiumLights() {
  // The first-buzzing family stays lit through question/contestant handoffs.
  const winner = state.faceoff.buzzedBy ? state.families.findIndex(f => f.playerIds.includes(state.faceoff.buzzedBy)) : -1;
  const points = [];
  for (const y of [734, 774, 814, 854, 894, 934]) {
    for (const x of [485, 528, 571, 614, 657, 700]) {
      if (y !== 734 || x > 500) points.push([x,y]);
    }
  }
  points.push([447,690],[477,690],[447,726],[447,960],[477,960],[447,985],[477,985]);
  const panels = [0,1].map(side => `<g class="podium-light-panel${winner === side ? ' lit' : ''}" data-podium-side="${side}">${points.map(([x,y])=>`<circle cx="${side === 0 ? x : 1426-x}" cy="${y}" r="7"/>`).join('')}</g>`).join('');
  const label = winner < 0 ? 'Faceoff podium lights off' : `${escapeHtml(state.families[winner].name)} family buzzed first`;
  return `<svg class="faceoff-podium-lights" viewBox="0 0 1438 1094" preserveAspectRatio="none" role="img" aria-label="${label}">${panels}</svg>`;
}

function dawsonFastStage() {
  const reveal = ['fast_reveal', 'fast_reveal_done', 'fast_results'].includes(state.phase);
  const idx = (reveal ? state.fastRevealIndex : state.fastIndex) ?? 0;
  const both = reveal && (idx === 1 || state.phase === 'fast_results');
  const contestant = state.players.find(p => p.id === state.fastPlayers[idx]);
  const total = (!reveal && state.fastIndex === 1 && state.fastFirstTotal != null) ? state.fastFirstTotal : state.fastScores.flat().reduce((sum, value) => sum + (Number(value) || 0), 0);
  const rows = column => Array.from({ length: 5 }, (_, i) => {
    const answer = state.fastAnswers[column]?.[i], points = state.fastScores[column]?.[i];
    const shown = reveal && answer != null;
    return `<div class="dawson-fast-row ${shown ? 'shown' : 'covered'}" data-fast-slot="${column}-${i}"><span>${shown ? escapeHtml(answer || 'NO ANSWER') : ''}</span><b>${reveal && points != null ? points : ''}</b></div>`;
  }).join('');
  const portraits = contestant ? fastHostAndContestant(contestant, reveal) : '';
  const clockVisible = !!contestant && ['fast_play','host_wait'].includes(state.phase);
  const remaining = state.fastDeadline ? Math.max(0, Math.ceil((state.fastDeadline - serverTime()) / 1000)) : state.fastIndex === 1 ? 60 : 45;
  const currentTop = reveal && idx === 1 && state.fastRevealCount ? state.fastTopAnswers?.[state.fastRevealCount - 1] : null;
  return `<section class="dawson-fast-shell ${both ? 'fast-both' : reveal ? 'fast-first-reveal' : 'fast-timed'}" aria-label="Fast Money"><div class="fast-split"><div class="fast-answer-panel">${rows(0)}</div><div class="fast-answer-panel">${both ? rows(1) : reveal ? portraits : rows(1)}</div><div class="fast-total">${dotNumber(total)}<span>TOTAL</span></div></div>${!reveal ? portraits : ''}${clockVisible ? `<div class="fast-clock" data-fast-clock>${dotNumber(remaining, 2)}</div>` : ''}${currentTop ? `<div class="fast-top-answer">NUMBER ONE: ${escapeHtml(currentTop)}</div>` : ''}${state.phase === 'fast_results' ? `<div class="fast-payout">${total >= 200 ? '$10,000' : '$' + Number(state.fastPrize || 0).toLocaleString()}<small>${total} POINTS</small></div>` : ''}</section>`;
}

function fastHostAndContestant(contestant, reveal){
  if(reveal)return `<div class="fast-host-pair reveal-pair" aria-label="Richard Dawson beside ${escapeHtml(contestant.name)}"><img class="fast-reveal-host" src="/assets/dawson-fast-reveal.png" alt="Richard Dawson">${contestantPortrait(contestant, 'dawson', 'fast-guest')}<img class="fast-reveal-arm" src="/assets/dawson-fast-reveal.png" alt="" aria-hidden="true"></div>`;
  return `<div class="fast-host-pair timed-pair"><img class="fast-timed-host" src="/assets/dawson-fast-reading.png" alt="Richard Dawson">${contestantPortrait(contestant, 'dawson', 'fast-guest')}</div>`;
}

function dawsonFamilyIntroduction(family) {
  const bulbs = Array.from({length:48},(_,i)=>{
    const angle=i/48*Math.PI*2;
    return `<circle cx="${500+473*Math.cos(angle)}" cy="${300+272*Math.sin(angle)}" r="7"/>`;
  }).join('');
  return `<section class="family-introduction" aria-label="Introducing the ${escapeHtml(family.name)} family"><div class="family-reveal-window"><div class="intro-family-lineup">${family.playerIds.map(id=>{
    const p=state.players.find(p=>p.id===id);
    return `<article class="intro-family-member">${contestantPortrait(p, 'dawson')}</article>`;
  }).join('')}</div><div class="intro-family-rail">${escapeHtml(family.name)} FAMILY</div><div class="family-name-door"><span class="oval-flourish flourish-top" aria-hidden="true">✦ ❧ ✦</span><h1 style="--name-size:${family.name.length>16?'6.5':family.name.length>10?'8':'11'}cqw">${escapeHtml(family.name)}</h1><span class="oval-flourish flourish-bottom" aria-hidden="true">✦ ❧ ✦</span></div></div><svg class="intro-oval-bulbs" viewBox="0 0 1000 600" preserveAspectRatio="none" aria-hidden="true">${bulbs}</svg></section>`;
}

function fitFamilyName(){
  const label=document.querySelector('.family-name-door h1');if(!label)return;
  const width=label.parentElement.clientWidth*.86;
  label.style.fontSize='';
  const measured=label.scrollWidth;
  if(measured>width)label.style.fontSize=`${parseFloat(getComputedStyle(label).fontSize)*width/measured}px`;
}
window.addEventListener?.('resize',fitFamilyName);
