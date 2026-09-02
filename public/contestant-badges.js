function contestantNameBadge(name, era) {
  const safe = escapeHtml(name);
  return `<svg class="contestant-name-badge badge-${era === 'harvey' ? 'harvey' : 'dawson'}" viewBox="0 0 200 80" role="img" aria-label="${safe}"><title>${safe}</title><ellipse cx="100" cy="40" rx="97" ry="37"/><text x="100" y="42" text-anchor="middle" dominant-baseline="middle">${safe}</text></svg>`;
}

function contestantPortrait(player, era, extraClass = '') {
  return `<div class="contestant-portrait ${extraClass}"><img src="${escapeHtml(player.photo)}" alt="${escapeHtml(player.name)}">${contestantNameBadge(player.name, era)}</div>`;
}

function fitContestantBadges() {
  for (const label of document.querySelectorAll?.('.contestant-name-badge text') || []) {
    label.removeAttribute('textLength');
    label.removeAttribute('lengthAdjust');
    // Measure in SVG units: fitting survives resizes and TV/phone scaling.
    if (label.getComputedTextLength() > 158) {
      label.setAttribute('textLength', '158');
      label.setAttribute('lengthAdjust', 'spacingAndGlyphs');
    }
  }
}

function refreshContestantBadges() {
  fitContestantBadges();
  document.fonts?.ready.then(fitContestantBadges);
}
window.addEventListener?.('resize', fitContestantBadges);
