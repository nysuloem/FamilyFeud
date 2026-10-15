(() => {
  let customOnly = false;
  let judgeActive = false;
  let judgePending = null;
  let uploadedGame = null;
  let displayWindow = null;

  const escape = value => String(value ?? '').replace(/[&<>'\"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));

  async function detectMode() {
    try {
      const response = await fetch('/api/custom-config', { cache: 'no-store' });
      const config = await response.json();
      customOnly = response.ok && config.customGameOnly === true;
    } catch { customOnly = false; }
    if (!customOnly) return;
    document.body.classList.add('custom-game-only');
    hideAiConsent();
    const bits = location.pathname.split('/').filter(Boolean);
    if (bits[0] === 'judge' && bits[1]) return joinJudge(bits[1].toUpperCase(), new URLSearchParams(location.search).get('token') || '');
    if (!bits.length) showCustomLanding();
  }

  function hideAiConsent() {
    const consent = document.querySelector('#kissConsent');
    if (consent) {
      consent.checked = false;
      const label = consent.closest('label');
      if (label) label.style.display = 'none';
    }
    const note = [...document.querySelectorAll('small')].find(el => /dynamic announcer is an AI-generated voice/i.test(el.textContent || ''));
    if (note) note.parentElement.style.display = 'none';
  }

  const observer = new MutationObserver(() => { if (customOnly) hideAiConsent(); });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  function showCustomLanding() {
    clearInterval(typeof bankStatusTimer !== 'undefined' ? bankStatusTimer : null);
    app.innerHTML = `<main class="page"><section class="landing custom-landing">
      <div class="logo"><span>FAMILY<br>FEUD</span></div>
      <p class="tagline">CUSTOM EVENT EDITION</p>
      <section class="panel custom-builder">
        <h1>Build your own Family Feud night</h1>
        <p>Download the template, enter your questions, board answers, point values, and optional accepted alternatives, then upload it here. This version uses no OpenAI services. The host judges every submitted answer.</p>
        <p><a class="secondary custom-download" href="/custom-game-template.csv" download>Download game-board template</a></p>
        <label>Event or game name<input id="customTitle" maxlength="60" placeholder="e.g., Biology Students' Association Family Feud"></label>
        <label>Game-board file<input id="customFile" type="file" accept=".csv,text/csv,.json,application/json"></label>
        <div id="customFileStatus" class="custom-file-status">No game file loaded yet.</div>
        <label>Presentation era<select id="customEra"><option value="random">Surprise me</option><option value="dawson">Richard Dawson era</option><option value="harvey">Steve Harvey era</option></select></label>
        <button class="primary" id="createCustomGame" disabled>Create Game + Host Console</button>
        <p><small>A separate TV/game-board window opens for the audience. Keep this window as the private host/judge console.</small></p>
      </section>
    </section></main>`;
    document.querySelector('#customFile').onchange = loadGameFile;
    document.querySelector('#createCustomGame').onclick = createCustomGame;
  }

  async function loadGameFile(event) {
    const file = event.target.files?.[0];
    const status = document.querySelector('#customFileStatus');
    uploadedGame = null;
    document.querySelector('#createCustomGame').disabled = true;
    if (!file) return status.textContent = 'No game file loaded yet.';
    try {
      const raw = await file.text();
      uploadedGame = file.name.toLowerCase().endsWith('.json') ? JSON.parse(raw) : gameFromCsv(raw);
      const counts = uploadedGame.rounds.map(r => r.answers.length).join(', ');
      status.innerHTML = `<strong>${escape(file.name)}</strong> loaded.<br>Rounds: ${counts} answers · Sudden Death: ${uploadedGame.suddenDeath.answers.length} · Fast Money: ${uploadedGame.fastMoney.length} questions.`;
      document.querySelector('#createCustomGame').disabled = false;
    } catch (error) {
      status.textContent = error.message || 'That file could not be read.';
    }
  }

  function parseCsv(csv) {
    const rows = [];
    let row = [], field = '', quoted = false;
    for (let i = 0; i < csv.length; i++) {
      const ch = csv[i];
      if (quoted) {
        if (ch === '"' && csv[i + 1] === '"') { field += '"'; i++; }
        else if (ch === '"') quoted = false;
        else field += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
      else field += ch;
    }
    if (field.length || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
    return rows.filter(r => r.some(cell => String(cell).trim()));
  }

  function gameFromCsv(csv) {
    const rows = parseCsv(csv);
    if (rows.length < 2) throw new Error('The CSV is empty.');
    const headers = rows[0].map(h => String(h).trim().toLowerCase());
    const required = ['type', 'round', 'question', 'answer', 'points', 'aliases'];
    for (const name of required) if (!headers.includes(name)) throw new Error(`The template is missing the “${name}” column.`);
    const records = rows.slice(1).map(row => Object.fromEntries(headers.map((h, i) => [h, String(row[i] ?? '').trim()]))).filter(r => r.type);
    const build = (type, round) => {
      const matches = records.filter(r => r.type.toUpperCase() === type && Number(r.round) === round);
      if (!matches.length) throw new Error(`${type === 'MAIN' ? `Round ${round}` : type === 'FAST' ? `Fast Money ${round}` : 'Sudden Death'} has no rows.`);
      const question = matches.find(r => r.question)?.question || '';
      return { question, answers: matches.map(r => ({ text: r.answer, points: Number(r.points), aliases: r.aliases.split('|').map(x => x.trim()).filter(Boolean) })) };
    };
    return {
      rounds: [1, 2, 3, 4].map(n => build('MAIN', n)),
      suddenDeath: build('SUDDEN', 1),
      fastMoney: [1, 2, 3, 4, 5].map(n => build('FAST', n))
    };
  }

  function createCustomGame() {
    if (!uploadedGame) return;
    const title = document.querySelector('#customTitle').value.trim();
    const era = document.querySelector('#customEra').value;
    const button = document.querySelector('#createCustomGame');
    button.disabled = true; button.textContent = 'Creating game…';
    displayWindow = window.open('about:blank', 'familyFeudCustomDisplay');
    socket.emit('createCustomRoom', { mode: 'host', era, game: { ...uploadedGame, title } }, result => {
      if (!result?.ok) {
        displayWindow?.close(); displayWindow = null;
        button.disabled = false; button.textContent = 'Create Game + Host Console';
        return toast(result?.error || 'Could not create the custom game.');
      }
      roomCode = result.code; isDisplay = false; judgeActive = true;
      history.replaceState({}, '', `/judge/${result.code}?token=${encodeURIComponent(result.judgeToken)}`);
      if (displayWindow) displayWindow.location.href = `/host/${result.code}`;
      else toast('Popup blocked. Use “Open audience display” from the host console.');
      renderJudge();
    });
  }

  function joinJudge(code, token) {
    judgeActive = true; roomCode = code; isDisplay = false;
    app.innerHTML = `<main class="page"><section class="panel"><h2>Opening host console…</h2></section></main>`;
    socket.emit('joinCustomJudge', { code, token }, result => {
      if (!result?.ok) {
        judgeActive = false;
        app.innerHTML = `<main class="page"><section class="panel"><h1>Host link unavailable</h1><p>${escape(result?.error || 'This host-control link is invalid or expired.')}</p></section></main>`;
        return;
      }
      state = result.room;
      renderJudge();
    });
  }

  function renderJudge() {
    if (!judgeActive || !customOnly) return;
    const s = state;
    if (!s) {
      app.innerHTML = `<main class="page"><section class="panel"><h2>Preparing host console…</h2></section></main>`;
      return;
    }
    const joinUrl = `${location.origin}/join/${s.code}`;
    const displayUrl = `${location.origin}/host/${s.code}`;
    const players = (s.players || []).map(p => `<li>${escape(p.name)}</li>`).join('') || '<li>No contestants have joined yet.</li>';
    const pending = judgePending ? `<section class="custom-judge-pending"><h2>Judge this answer</h2><p><strong>${escape(judgePending.contestant)}</strong> answered:</p><div class="custom-guess">“${escape(judgePending.guess)}”</div><p class="custom-question">${escape(judgePending.question)}</p><div class="custom-answer-grid">${judgePending.answers.filter(a => !a.revealed).map(a => `<button class="primary custom-accept" data-accept="${a.index}">Accept as ${escape(a.text)} <small>${a.points}</small></button>`).join('')}</div><button class="secondary custom-reject" id="customReject">Reject / strike</button></section>` : `<section class="custom-judge-wait"><h2>No answer waiting for a ruling</h2><p>${escape(s.message || 'The game is in progress.')}</p><p><strong>Phase:</strong> ${escape(s.phase)}</p></section>`;
    app.innerHTML = `<main class="page custom-judge-console"><section class="panel"><div class="custom-console-head"><div><h1>${escape(s.customTitle || 'Custom Family Feud')}</h1><p>HOST / JUDGE CONSOLE · Game <strong>${escape(s.code)}</strong></p></div><button class="secondary" id="openDisplay">Open audience display</button></div>${s.phase === 'lobby' ? `<div class="custom-lobby-controls"><p><strong>${s.players.length}/10 contestants joined.</strong></p><ul>${players}</ul><p>Contestant link: <span class="share-url">${escape(joinUrl)}</span></p><button class="primary" id="customStart" ${s.players.length < 2 ? 'disabled' : ''}>Start the Game</button>${s.players.length < 2 ? '<p><small>At least two contestants are needed.</small></p>' : ''}</div>` : pending}</section></main>`;
    document.querySelector('#openDisplay').onclick = () => window.open(displayUrl, 'familyFeudCustomDisplay');
    const start = document.querySelector('#customStart');
    if (start) start.onclick = () => { start.disabled = true; socket.emit('startGame', { code: s.code }, result => { if (!result?.ok) { start.disabled = false; toast(result.error); } }); };
    document.querySelectorAll('[data-accept]').forEach(button => button.onclick = () => sendJudgeDecision('accept', Number(button.dataset.accept)));
    const reject = document.querySelector('#customReject'); if (reject) reject.onclick = () => sendJudgeDecision('reject', -1);
  }

  function sendJudgeDecision(action, answerIndex) {
    document.querySelectorAll('.custom-accept, #customReject').forEach(button => button.disabled = true);
    socket.emit('customJudgeDecision', { code: state.code, action, answerIndex }, result => {
      if (!result?.ok) { toast(result?.error || 'Could not record that ruling.'); return renderJudge(); }
      judgePending = null;
      renderJudge();
    });
  }

  socket.on('customJudgeNeeded', payload => {
    if (!customOnly || !judgeActive) return;
    judgePending = payload;
    renderJudge();
  });

  socket.on('state', next => {
    if (!customOnly) return;
    if (judgeActive) {
      state = next;
      if (judgePending && !next.inputLocked) judgePending = null;
      queueMicrotask(renderJudge);
    }
  });

  socket.on('connect', () => {
    if (!customOnly || !judgeActive) return;
    const bits = location.pathname.split('/').filter(Boolean);
    if (bits[0] === 'judge' && bits[1]) socket.emit('joinCustomJudge', { code: bits[1].toUpperCase(), token: new URLSearchParams(location.search).get('token') || '' }, result => { if (result?.ok) { state = result.room; renderJudge(); } });
  });

  const style = document.createElement('style');
  style.textContent = `
    .custom-builder{max-width:760px;margin:24px auto;text-align:left}.custom-builder label{display:block;margin:16px 0}.custom-builder input,.custom-builder select{width:100%;margin-top:6px}.custom-download{display:inline-block;text-decoration:none}.custom-file-status{padding:12px;border:1px solid rgba(255,255,255,.2);border-radius:8px;margin:10px 0}.custom-judge-console{max-width:920px;margin:0 auto}.custom-console-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.custom-lobby-controls ul{columns:2}.custom-judge-pending{margin-top:24px;padding-top:18px;border-top:1px solid rgba(255,255,255,.2)}.custom-guess{font-size:2rem;font-weight:800;margin:12px 0}.custom-question{font-size:1.1rem}.custom-answer-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:18px 0}.custom-accept{min-height:58px}.custom-accept small{display:block;opacity:.75}.custom-reject{width:100%;font-size:1.05rem}.custom-judge-wait{margin-top:24px;padding:18px;border:1px solid rgba(255,255,255,.15);border-radius:10px}@media(max-width:680px){.custom-console-head{display:block}.custom-console-head button{margin-top:10px}.custom-answer-grid{grid-template-columns:1fr}.custom-lobby-controls ul{columns:1}.custom-guess{font-size:1.5rem}}
  `;
  document.head.appendChild(style);

  detectMode();
})();
