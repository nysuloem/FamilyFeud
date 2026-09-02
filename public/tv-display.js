// A fixed broadcast frame scales uniformly, including browser chrome/zoom changes.
function tvDisplayScale(width, height) {
  return Math.max(0, Math.min(width / 1920, height / 1080));
}

function updateTVDisplay() {
  const enabled = isDisplay && state?.mode === 'host';
  document.body?.classList?.toggle('tv-display', enabled);
  const root = document.documentElement;
  let button = document.querySelector('#tvFullscreen');
  if (!enabled) {
    root?.style.removeProperty('--tv-scale');
    button?.remove();
    return;
  }
  root?.style.setProperty('--tv-scale', tvDisplayScale(window.innerWidth, window.innerHeight));
  if (!button && root?.requestFullscreen) {
    button = document.createElement('button');
    button.id = 'tvFullscreen';
    button.className = 'tv-fullscreen secondary';
    button.onclick = async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await root.requestFullscreen();
      } catch { toast('Use your browser’s full-screen option to fill the TV.'); }
    };
    document.body.append(button);
  }
  if (button) button.textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen';
}

window.addEventListener?.('resize', updateTVDisplay);
document.addEventListener?.('fullscreenchange', updateTVDisplay);
