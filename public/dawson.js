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
    return `<div class="stage-player ${state.turnPlayerId === id ? 'active' : ''}"><img src="${p.photo}" alt="${escapeHtml(p.name)}"><span>${escapeHtml(p.name)}</span></div>`;
  }).join('')}</div><div class="stage-podium">${escapeHtml(family.name)}<small>FAMILY</small></div></section>`;
}

function dawsonStage(round) {
  return `<section class="dawson-stage" aria-label="Richard Dawson era Family Feud stage"><div class="stage-round">${state.round === 4 ? 'SUDDEN DEATH' : `ROUND ${state.round + 1}`}</div><div class="dawson-oval"><div class="bank-display" aria-label="Round bank">${dotNumber(state.bank)}</div>${dawsonBoard(round)}<div class="score-wing wing-left" aria-label="${escapeHtml(state.families[0].name)} score">${dotNumber(state.scores[0])}</div><div class="score-wing wing-right" aria-label="${escapeHtml(state.families[1].name)} score">${dotNumber(state.scores[1])}</div></div>${dawsonTeam(0)}${dawsonTeam(1)}</section>`;
}

function dawsonFaceoff() {
  const contestants = state.faceoff.players.map((id, side) => {
    const p = state.players.find(p => p.id === id);
    const family = state.families.find(f => f.playerIds.includes(id));
    return `<article class="faceoff-contestant faceoff-side-${side} ${state.turnPlayerId === id ? 'active' : ''}"><img src="${p.photo}" alt="${escapeHtml(p.name)}"><strong>${escapeHtml(p.name)}</strong><span>${escapeHtml(family.name)} FAMILY</span></article>`;
  }).join('');
  return `<section class="dawson-faceoff" aria-label="Richard Dawson faceoff podium"><div class="stage-round">${state.round === 4 ? 'SUDDEN DEATH' : `ROUND ${state.round + 1}`} · FACE-OFF</div>${contestants}<div class="faceoff-podium-label">${state.faceoff.buzzedBy ? 'SURVEY SAYS' : 'FAMILY FEUD'}</div></section>`;
}

function dawsonFastStage() {
  const reveal = ['fast_reveal', 'fast_reveal_done', 'fast_results'].includes(state.phase);
  const idx = state.fastRevealIndex ?? state.fastIndex ?? 0;
  const contestant = state.players.find(p => p.id === state.fastPlayers[idx]);
  const total = state.fastScores.flat().reduce((sum, value) => sum + (Number(value) || 0), 0);
  const rows = column => Array.from({ length: 5 }, (_, i) => {
    const shown = reveal && (state.phase === 'fast_results' || column < idx || (column === idx && i < state.fastRevealCount));
    return `<div class="dawson-fast-row ${shown ? 'shown' : ''}" data-fast-slot="${column}-${i}"><span>${shown ? escapeHtml(state.fastAnswers[column]?.[i] || '—') : ''}</span><b>${shown ? state.fastScores[column]?.[i] ?? 0 : ''}</b></div>`;
  }).join('');
  const portrait = contestant ? `<div class="fast-portrait"><img src="${contestant.photo}" alt="${escapeHtml(contestant.name)}"><strong>${escapeHtml(contestant.name)}</strong></div>` : '<div class="fast-portrait"><strong>FAST MONEY</strong></div>';
  const remaining = state.fastDeadline ? Math.max(0, Math.ceil((state.fastDeadline - serverTime()) / 1000)) : state.fastIndex === 1 ? 60 : 45;
  const currentTop = reveal && idx === 1 && state.fastRevealCount ? state.fastTopAnswers?.[state.fastRevealCount - 1] : null;
  return `<section class="dawson-fast-shell"><div class="fast-bank">${dotNumber(total)}</div><div class="fast-split"><div class="fast-answer-panel">${rows(0)}</div><div class="fast-answer-panel">${reveal && idx === 1 ? rows(1) : portrait}</div></div><div class="fast-clock" data-fast-clock>${dotNumber(remaining, 2)}</div>${currentTop ? `<div class="fast-top-answer">NUMBER ONE: ${escapeHtml(currentTop)}</div>` : ''}${state.phase === 'fast_results' ? `<div class="fast-payout">${total >= 200 ? '$10,000' : '$' + Number(state.fastPrize || 0).toLocaleString()}<small>${total} POINTS</small></div>` : ''}</section>`;
}
