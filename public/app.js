/* Jev Stories client. One file, no framework. The server owns all game
   state; this file renders snapshots and sends intents. */
(() => {
  'use strict';

  const LENGTHS = {
    short: { label: 'Short', min: 4, max: 7 },
    medium: { label: 'Medium', min: 7, max: 12 },
    long: { label: 'Long', min: 12, max: 18 },
  };
  const DIMS = [
    { key: 'funny', label: 'Funny', help: 'Wit, absurdity, timing' },
    { key: 'continuity', label: 'Flows', help: 'Follows the story so far' },
    { key: 'theme', label: 'On theme', help: 'Belongs to the theme' },
    { key: 'surprise', label: 'Surprising', help: 'Twists and wild imagery' },
  ];
  // Display fallback until /api/rooms answers.
  const ROOMS = [
    { code: 'E', label: 'Everyone', slug: 'everyone', tagline: 'Clean fun for all ages', filters: [], players: 0 },
    { code: 'T', label: 'Teen', slug: 'teen', tagline: 'Mild language and cartoon mayhem are fine', filters: [], players: 0 },
    { code: 'M', label: 'Mature', slug: 'mature', tagline: 'Strong language and adult humor allowed', filters: [], players: 0 },
    { code: 'A', label: 'Adult', slug: 'adult', tagline: 'Anything goes, except hate and harassment', filters: [], players: 0 },
  ];

  const $ = (sel, root = document) => root.querySelector(sel);
  const screenEl = $('#screen');
  const topbar = $('#topbar');
  const connEl = $('#conn');
  const drawer = $('#drawer');
  const toastEl = $('#toast');
  const leaveDialog = $('#leave-dialog');

  const esc = (v) =>
    String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const pct = (x) => `${Math.round((Number(x) || 0) * 100)}%`;

  // ---------------------------------------------------------------- storage
  // Session storage keeps tabs independent; local storage survives a closed tab.
  const store = {
    get(k) {
      try {
        const v = sessionStorage.getItem(k);
        if (v != null) return v;
      } catch {
        /* blocked */
      }
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        sessionStorage.setItem(k, v);
      } catch {
        /* blocked */
      }
      try {
        localStorage.setItem(k, v);
      } catch {
        /* blocked */
      }
    },
    del(k) {
      try {
        sessionStorage.removeItem(k);
      } catch {
        /* blocked */
      }
      try {
        localStorage.removeItem(k);
      } catch {
        /* blocked */
      }
    },
  };
  const identityKey = (code) => `jev:room:${code}`;
  function loadIdentity(code) {
    try {
      return JSON.parse(store.get(identityKey(code)) || 'null');
    } catch {
      return null;
    }
  }
  function saveIdentity(code, ident) {
    store.set(identityKey(code), JSON.stringify(ident));
  }

  // ------------------------------------------------------------------ state
  const app = {
    screen: 'home',
    rooms: ROOMS,
    homeError: '',
    busy: false,
    code: null,
    nick: '',
    token: null,
    me: null,
    ws: null,
    want: false,
    retries: 0,
    connLost: false,
    state: null,
    clockOffset: 0,
    draft: '',
    draftKey: null,
    themeDraft: '',
    lenDraft: 'medium',
    lastKey: null,
    drawerOpen: false,
    roomsTimer: null,
    roster: [],
    serverVersion: null,
  };

  function roomBySlug(slug) {
    return app.rooms.find((r) => r.slug === String(slug || '').toLowerCase()) || null;
  }
  function roomByCode(code) {
    return app.rooms.find((r) => r.code === code) || null;
  }
  function codeFromUrl() {
    const seg = location.pathname.replace(/^\/+|\/+$/g, '').toLowerCase();
    const room = roomBySlug(seg);
    return room ? room.code : null;
  }

  // ------------------------------------------------------------------ toast
  let toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3200);
  }

  // ------------------------------------------------------------------ socket
  function send(obj) {
    if (app.ws && app.ws.readyState === WebSocket.OPEN) app.ws.send(JSON.stringify(obj));
    else toast('Not connected right now.');
  }

  function openSocket() {
    if (!app.want || app.ws) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws;
    try {
      ws = new WebSocket(`${proto}://${location.host}/ws/${app.code}`);
    } catch {
      scheduleReconnect();
      return;
    }
    app.ws = ws;
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'join', nick: app.nick, token: app.token }));
    });
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string' || ev.data[0] !== '{') return;
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      handleMessage(msg);
    });
    ws.addEventListener('close', (ev) => {
      if (app.ws !== ws) return;
      app.ws = null;
      if (!app.want) return;
      if (ev.code === 4000) {
        app.want = false;
        toast('This seat was taken over by another tab.');
        leaveLocal(false);
        return;
      }
      app.connLost = true;
      render();
      scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    const delay = Math.min(10000, 800 * 2 ** Math.min(app.retries, 4));
    app.retries += 1;
    setTimeout(() => {
      if (app.want && !app.ws) openSocket();
    }, delay);
  }

  setInterval(() => {
    if (app.ws && app.ws.readyState === WebSocket.OPEN) app.ws.send('ping');
  }, 25000);

  function handleMessage(msg) {
    switch (msg.type) {
      case 'joined':
        app.me = { id: msg.playerId, nick: msg.nick };
        app.token = msg.token;
        app.nick = msg.nick;
        app.retries = 0;
        app.connLost = false;
        saveIdentity(app.code, { token: msg.token, nick: msg.nick });
        store.set('jev:lastRoom', app.code);
        break;
      case 'state':
        // A deploy changed the protocol under us: fetch the matching client.
        if (app.serverVersion != null && msg.v !== app.serverVersion) {
          location.reload();
          return;
        }
        app.serverVersion = msg.v;
        app.clockOffset = msg.now - Date.now();
        // The roster only travels when it changed; keep the last one otherwise.
        if (Array.isArray(msg.players)) app.roster = msg.players;
        else msg.players = app.roster || [];
        app.state = msg;
        app.connLost = false;
        render();
        break;
      case 'error':
        toast(msg.message || 'Something went wrong');
        if (msg.fatal) leaveLocal(true);
        break;
      case 'left':
        leaveLocal(true);
        break;
      default:
        break;
    }
  }

  function enterRoom(code, nick, token) {
    const room = roomByCode(code) || { slug: code.toLowerCase() };
    Object.assign(app, {
      code,
      nick,
      token: token || null,
      me: null,
      state: null,
      screen: 'room',
      want: true,
      retries: 0,
      connLost: false,
      lastKey: null,
      draft: '',
      draftKey: null,
      themeDraft: '',
      lenDraft: 'medium',
      drawerOpen: false,
    });
    clearInterval(app.roomsTimer);
    history.replaceState(null, '', `/${room.slug}`);
    openSocket();
    render();
  }

  function leaveRoom() {
    send({ type: 'leave' });
    leaveLocal(true);
  }

  function leaveLocal(clearIdentity) {
    app.want = false;
    if (app.ws) {
      try {
        app.ws.close();
      } catch {
        /* ignore */
      }
      app.ws = null;
    }
    if (clearIdentity && app.code) {
      store.del(identityKey(app.code));
      if (store.get('jev:lastRoom') === app.code) store.del('jev:lastRoom');
    }
    Object.assign(app, { screen: 'home', state: null, me: null, token: null, code: null, drawerOpen: false, connLost: false });
    history.replaceState(null, '', '/');
    render();
    refreshRooms();
  }

  // ------------------------------------------------------------- home flow
  function setHomeError(msg) {
    app.homeError = msg || '';
    const el = $('#home-error');
    if (el) el.textContent = app.homeError;
  }

  async function refreshRooms() {
    clearInterval(app.roomsTimer);
    if (app.screen !== 'home') return;
    try {
      const res = await fetch('/api/rooms', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (data && Array.isArray(data.rooms) && data.rooms.length) {
          app.rooms = data.rooms;
          if (app.screen === 'home') renderRoomCards();
        }
      }
    } catch {
      /* offline: keep the fallback list */
    }
    if (app.screen === 'home') app.roomsTimer = setTimeout(refreshRooms, 8000);
  }

  function joinFromHome(code) {
    const nick = (($('#nick') && $('#nick').value) || '').trim().slice(0, 20);
    if (!nick) {
      setHomeError('Pick a nickname first.');
      const input = $('#nick');
      if (input) input.focus();
      return;
    }
    if (!roomByCode(code)) return setHomeError('That room does not exist.');
    setHomeError('');
    store.set('jev:nick', nick);
    const ident = loadIdentity(code);
    enterRoom(code, nick, ident && ident.nick === nick ? ident.token : null);
  }

  // ----------------------------------------------------------------- render
  function render() {
    if (app.screen === 'home') return renderHome();
    topbar.hidden = false;
    connEl.hidden = !app.connLost;
    const room = roomByCode(app.code);
    $('#tb-room').textContent = room ? `${room.label} room` : 'Room';
    const s = app.state;
    if (!s) {
      $('#tb-count').textContent = '';
      $('#tb-story').textContent = '';
      screenEl.innerHTML = `<section class="card center"><div class="spinner"></div><p class="muted">Joining the ${esc(
        room ? room.label : '',
      )} room…</p>${app.retries > 4 ? '<button class="btn" data-action="retry">Try again</button>' : ''}</section>`;
      return;
    }
    const me = s.players.find((p) => p.id === s.youId) || null;
    const connected = s.players.filter((p) => p.connected).length;
    $('#tb-count').textContent = `${connected} ${connected === 1 ? 'player' : 'players'}`;
    $('#tb-story').textContent =
      s.story && s.story.theme ? `Story #${s.story.index}: ${s.story.theme}` : s.story ? `Story #${s.story.index}` : '';

    const key = [
      s.phase,
      s.story && s.story.index,
      s.round && s.round.index,
      s.round && s.round.attempts,
      s.results && s.results.judgedAt,
      s.lastStory && s.lastStory.endedAt,
      s.story && s.story.theme ? 1 : 0,
      s.story && s.story.setterId === s.youId ? 1 : 0,
    ].join('|');

    if (key === app.lastKey && ['writing', 'theme', 'paused', 'reveal'].includes(s.phase)) {
      patch(s, me);
    } else {
      app.lastKey = key;
      screenEl.innerHTML = buildScreen(s, me);
      afterBuild(s, me);
    }
    renderDrawer(s);
    tick();
  }

  function roomCardsHtml() {
    return app.rooms
      .map(
        (r) => `<button class="room-card" data-action="join" data-code="${esc(r.code)}">
          <span class="room-rating">${esc(r.code)}</span>
          <span class="room-body">
            <b>${esc(r.label)}</b>
            <span class="room-tagline">${esc(r.tagline)}</span>
            ${r.filters && r.filters.length ? `<span class="room-filters">Jev filters ${esc(r.filters.join(', '))}</span>` : ''}
          </span>
          <span class="room-count">${r.players} ${r.players === 1 ? 'playing' : 'playing'}</span>
        </button>`,
      )
      .join('');
  }

  function renderRoomCards() {
    const holder = $('#room-cards');
    if (holder) holder.innerHTML = roomCardsHtml();
  }

  function renderHome() {
    topbar.hidden = true;
    connEl.hidden = true;
    drawer.hidden = true;
    const savedNick = store.get('jev:nick') || '';
    screenEl.innerHTML = `
      <section class="hero">
        <img class="logo" src="/icons/icon.svg" alt="" width="96" height="96">
        <h1>Jev Stories</h1>
        <p class="tagline">Everyone writes the next line. Jev picks the winner.</p>
      </section>
      <section class="card stack">
        <label><span class="lbl">Your nickname</span><input id="nick" maxlength="20" autocomplete="nickname" placeholder="e.g. Captain Goose" value="${esc(savedNick)}"></label>
        <div class="label" style="margin-top:6px">Pick a room</div>
        <div id="room-cards" class="room-list">${roomCardsHtml()}</div>
        <p class="error" id="home-error">${esc(app.homeError)}</p>
      </section>
      <section class="how">
        <h2>How it plays</h2>
        <ol>
          <li><b>Take turns setting a theme.</b> The theme setter picks a length and tunes what Jev rewards.</li>
          <li><b>Everyone writes the next line.</b> One sentence each, against the clock.</li>
          <li><b>Jev picks.</b> TypeSafe's Jev reads every line and the funniest one joins the story. One point to its author.</li>
          <li><b>Tap your favorite.</b> Taps never change the pick, but they teach Jev what the room enjoys.</li>
          <li><b>Jev also decides when the story is done.</b> Then the next player sets a theme, for as long as two of you are here.</li>
        </ol>
      </section>`;
  }

  // ----------------------------------------------------------- fragments
  function playersHtml(s) {
    return `<ul class="players">${s.players
      .map(
        (p) =>
          `<li><span class="dot ${p.connected ? '' : 'off'}"></span>${esc(p.nick)}${p.id === s.youId ? '<span class="badge you">you</span>' : ''}</li>`,
      )
      .join('')}</ul>`;
  }

  function weightsPct(weights) {
    const total = DIMS.reduce((t, d) => t + (Number(weights && weights[d.key]) || 0), 0) || 1;
    const out = {};
    for (const d of DIMS) out[d.key] = (Number(weights && weights[d.key]) || 0) / total;
    return out;
  }

  function mixChipsHtml(weights) {
    const p = weightsPct(weights);
    return DIMS.map((d) => `<span class="chip">${d.label} <b>${pct(p[d.key])}</b></span>`).join('');
  }

  function slidersHtml(weights) {
    const p = weightsPct(weights);
    return `<div data-sliders>${DIMS.map(
      (d) =>
        `<label class="slider"><span title="${esc(d.help)}">${d.label}</span><input type="range" min="0" max="100" step="5" value="${
          Number(weights && weights[d.key]) || 0
        }" data-dim="${d.key}"><b class="pct" data-pct="${d.key}">${pct(p[d.key])}</b></label>`,
    ).join('')}<p class="hint">Jev scores every line on each of these. The sliders set how much each one counts this round. They start from what this room's players have liked.</p></div>`;
  }

  function storyListHtml(story, highlightLast) {
    if (!story || !story.sentences.length) return '<p class="story-empty">No lines yet. The winner of this round opens the story.</p>';
    return `<ol class="story">${story.sentences
      .map(
        (x, i) =>
          `<li data-n="${i + 1}" class="${highlightLast && i === story.sentences.length - 1 ? 'new' : ''}">${esc(x.text)}<span class="by">${esc(
            x.authorNick,
          )}</span></li>`,
      )
      .join('')}</ol>`;
  }

  function storyPanelHtml(s, highlightLast) {
    const st = s.story;
    if (!st) return '';
    const len = LENGTHS[st.length] || LENGTHS.medium;
    return `<section class="story-panel">
      <div class="theme-line"><span class="label">Theme</span><b>${esc(st.theme)}</b><span class="pill">${len.label}, ${len.min} to ${len.max} lines</span></div>
      ${storyListHtml(st, highlightLast)}
    </section>`;
  }

  function scoreboardCardHtml(s) {
    const sorted = [...s.players].sort((a, b) => b.score - a.score).slice(0, 10);
    return `<section class="card"><h3>Scores</h3><ol class="scores">${sorted
      .map(
        (p) =>
          `<li><span class="dot ${p.connected ? '' : 'off'}"></span>${esc(p.nick)}${p.id === s.youId ? '<span class="badge you">you</span>' : ''}<span class="pts">${p.score}</span></li>`,
      )
      .join('')}</ol>${s.players.length > 10 ? `<p class="hint">and ${s.players.length - 10} more, see Scores in the top bar</p>` : ''}</section>`;
  }

  function submittedHtml(s) {
    const connected = s.players.filter((p) => p.connected).length;
    const n = s.round ? s.round.submittedCount : 0;
    return `${n} of ${connected} ${connected === 1 ? 'player has' : 'players have'} written`;
  }

  function myStatusHtml(s) {
    const mine = s.round ? s.round.mine : '';
    if (!mine) return '';
    if (mine === app.draft.trim()) return 'Submitted. You can still edit and resend until the round closes.';
    return 'Edited since you sent it. Tap Update to resend.';
  }

  // -------------------------------------------------------------- screens
  function buildScreen(s, me) {
    switch (s.phase) {
      case 'theme':
        return buildTheme(s);
      case 'writing':
        return buildWriting(s);
      case 'judging':
        return buildJudging(s);
      case 'reveal':
        return buildReveal(s, me);
      case 'storyEnd':
        return buildStoryEnd(s);
      case 'paused':
      default:
        return buildPaused(s);
    }
  }

  function buildPaused(s) {
    const room = s.room || {};
    return `
      <section class="card center">
        <h2>Waiting for players</h2>
        <p class="muted">The game starts as soon as two people are in the ${esc(room.label || '')} room.</p>
        <button class="btn primary" data-action="copy-link">Copy invite link</button>
        <div style="margin-top:16px" data-players>${playersHtml(s)}</div>
      </section>
      ${s.lastStory ? '' : ''}
      ${scoreboardCardHtml(s)}`;
  }

  function buildTheme(s) {
    const st = s.story;
    const total = s.settings.themeSeconds * 1000;
    if (st.setterId === s.youId) {
      return `
        <section class="card">
          <div class="row between"><h2>You set the stage</h2><div class="timer" data-deadline="${s.deadline}"></div></div>
          <div class="bar" data-bar="${s.deadline}" data-total="${total}"><i></i></div>
          <p class="muted small" style="margin-top:10px">Story #${st.index}. Give everyone a theme, pick a length, and tune what Jev rewards. If time runs out, the next player takes over.</p>
          <label><span class="lbl">Theme</span><input id="theme" maxlength="80" autocomplete="off" placeholder="e.g. A heist pulled off by grandmothers" value="${esc(
            app.themeDraft,
          )}"></label>
          <div class="label" style="margin-top:14px">Story length</div>
          <div class="seg" data-len-seg>${['short', 'medium', 'long']
            .map(
              (k) =>
                `<button type="button" data-action="pick-len" data-len="${k}" aria-pressed="${app.lenDraft === k}">${LENGTHS[k].label}<small>${LENGTHS[k].min} to ${LENGTHS[k].max} lines</small></button>`,
            )
            .join('')}</div>
          <details open style="margin-top:14px"><summary>Jev's taste</summary>${slidersHtml(st.weights)}</details>
          <button class="btn primary big" data-action="set-theme" style="margin-top:16px">Start the story</button>
        </section>`;
    }
    return `
      <section class="card center">
        <div class="label">Story #${st.index}</div>
        <h2>${esc(st.setterNick)} is choosing a theme</h2>
        <div class="timer" style="text-align:center" data-deadline="${s.deadline}"></div>
        <p class="muted">Get your typing fingers ready.</p>
      </section>
      ${scoreboardCardHtml(s)}`;
  }

  function buildWriting(s) {
    const st = s.story;
    const isSetter = st.setterId === s.youId;
    const total = s.settings.writingSeconds * 1000;
    const mine = s.round.mine || '';
    const replay = s.round.attempts > 0 ? '<p class="hint">This round replays. Your earlier line is still in, edit it if you like.</p>' : '';
    return `
      ${storyPanelHtml(s, false)}
      <section class="card write">
        <div class="row between"><h2>Line ${s.round.index}</h2><div class="timer" data-deadline="${s.deadline}"></div></div>
        <div class="bar" data-bar="${s.deadline}" data-total="${total}"><i></i></div>
        ${replay}
        <textarea id="sentence" maxlength="${s.settings.maxSentenceChars}" rows="3" placeholder="${
          st.sentences.length ? 'Write the next sentence…' : 'Write the opening line…'
        }" style="margin-top:10px"></textarea>
        <div class="row between" style="margin-top:8px">
          <span class="muted small" data-chars>0/${s.settings.maxSentenceChars}</span>
          <button class="btn primary" data-action="submit" data-submit>${mine ? 'Update' : 'Submit'}</button>
        </div>
        <p class="muted small" data-submitted>${submittedHtml(s)}</p>
        <p class="status" data-my-status>${myStatusHtml(s)}</p>
      </section>
      ${
        isSetter
          ? `<details open class="card"><summary>Jev's taste this round (you can change it)</summary>${slidersHtml(st.weights)}</details>`
          : `<section class="card"><div class="label">Jev's taste this round</div><div class="chips" data-mix>${mixChipsHtml(st.weights)}</div></section>`
      }`;
  }

  function buildJudging(s) {
    const n = s.round ? s.round.submittedCount : 0;
    return `
      ${storyPanelHtml(s, false)}
      <section class="card judging">
        <div class="spinner"></div>
        <h2>Jev is reading…</h2>
        <p class="muted">${n} ${n === 1 ? 'line' : 'lines'} for line ${s.round ? s.round.index : ''} of the story.</p>
      </section>`;
  }

  function dimsHtml(row) {
    if (!row.dims) return '';
    return `<div class="dims">${DIMS.map(
      (d) => `<div class="dim">${d.label} ${pct(row.dims[d.key])}<i><b style="width:${Math.round((row.dims[d.key] || 0) * 100)}%"></b></i></div>`,
    ).join('')}</div>`;
  }

  function tapBadgeHtml(count, favorite) {
    return `<span class="tapcount ${favorite ? 'fav' : ''}" data-tapcount>${count ? `${count} ${count === 1 ? 'pick' : 'picks'}` : ''}${
      favorite ? ' · players’ favorite' : ''
    }</span>`;
  }

  function resultHtml(row, s) {
    const res = s.results;
    const rank = row.index;
    const own = row.authorId === s.youId;
    const tapped = res.myTap === rank;
    const counts = res.tapCounts || [];
    const max = Math.max(0, ...counts);
    const favorite = max > 0 && counts[rank] === max;
    const cls = ['result', rank === 0 ? 'winner' : '', own ? 'own' : 'tappable', tapped ? 'tapped' : ''].join(' ');
    const label = rank === 0 ? 'Jev picked' : `#${rank + 1}`;
    return `<article class="${cls}" ${own ? '' : `data-action="tap" data-index="${rank}"`} role="${own ? '' : 'button'}" tabindex="${own ? -1 : 0}" title="${
      own ? 'Your own line' : tapped ? 'Your pick. Tap again to clear it.' : 'Tap to make this your pick'
    }">
      <div class="rank">${label}${own ? ' · yours' : ''}<span class="mypick" data-mypick ${tapped ? '' : 'hidden'}> · your pick</span></div>
      <p class="text">${esc(row.text)}</p>
      <div class="meta"><span class="author">by ${esc(row.authorNick)}</span><span class="share">${pct(row.share)}</span></div>
      ${dimsHtml(row)}
      ${tapBadgeHtml(counts[rank] || 0, favorite)}
    </article>`;
  }

  function buildReveal(s, me) {
    const res = s.results || {};
    const top = res.top || [];
    const others = res.others || [];
    const filtered = res.filtered || [];
    const mine = filtered.find((f) => f.authorId === s.youId);
    const hasWinner = Boolean(res.winnerId);
    const isSetter = s.story && s.story.setterId === s.youId;
    let next;
    if (!hasWinner) next = `Trying again in <span class="timer inline" data-deadline="${s.deadline}"></span>`;
    else if (res.ends) next = `The story is complete. Reading it in <span class="timer inline" data-deadline="${s.deadline}"></span>`;
    else next = `Next line in <span class="timer inline" data-deadline="${s.deadline}"></span>`;

    return `
      <section class="card">
        <div class="row between"><h2>${hasWinner ? 'Jev has spoken' : 'No winner this round'}</h2>${
          isSetter ? '<button class="btn small" data-action="skip">Skip ahead</button>' : ''
        }</div>
        ${res.error ? `<p class="error">${esc(res.error)}</p>` : ''}
        ${
          top.length > 1
            ? '<p class="hint" style="margin:0 0 10px">Tap the line you liked best, not your own. Changed your mind? Tap another line, or tap your pick again to clear it. Only your last pick counts when the timer ends. Picks never change the outcome; they teach Jev what this room enjoys.</p>'
            : ''
        }
        <div class="podium" data-podium>${top.map((r) => resultHtml(r, s)).join('')}</div>
        ${
          others.length
            ? `<details style="margin-top:10px"><summary class="muted">Everyone else (${res.othersTotal || others.length})</summary><div class="podium" style="margin-top:8px">${others
                .map((r) => `<article class="result"><p class="text">${esc(r.text)}</p><div class="meta"><span>by ${esc(r.authorNick)}</span><span class="share">${pct(r.share)}</span></div></article>`)
                .join('')}${
                (res.othersTotal || 0) > others.length ? `<p class="hint">and ${res.othersTotal - others.length} more lines below these</p>` : ''
              }</div></details>`
            : ''
        }
        ${
          filtered.length
            ? `<p class="hint" style="margin-top:10px">${filtered.length} ${filtered.length === 1 ? 'line was' : 'lines were'} filtered for this room.${
                mine ? ` Yours was one of them (${esc((mine.flags || []).join(', '))}).` : ''
              }</p>`
            : ''
        }
        <p class="next">${next}</p>
      </section>
      ${storyPanelHtml(s, hasWinner)}`;
  }

  function storyText(st) {
    const len = LENGTHS[st.length] || LENGTHS.medium;
    const lines = st.sentences.map((x, i) => `${i + 1}. ${x.text}  (${x.authorNick})`);
    return `${st.theme}\nA Jev Stories tale, ${len.label.toLowerCase()} length, theme by ${st.setterNick}\n\n${lines.join('\n')}\n\n${st.endText || ''}\n`;
  }

  function buildStoryEnd(s) {
    const st = s.lastStory;
    if (!st) return '<section class="card"><p>Loading the story…</p></section>';
    const len = LENGTHS[st.length] || LENGTHS.medium;
    return `
      <section class="card story-final">
        <div class="label">Story #${st.index} · ${len.label} · theme by ${esc(st.setterNick)}</div>
        <h2>${esc(st.theme)}</h2>
        <ol class="story final">${st.sentences.map((x, i) => `<li data-n="${i + 1}">${esc(x.text)}<span class="by">${esc(x.authorNick)}</span></li>`).join('')}</ol>
        <p class="muted" style="margin-top:12px">${esc(st.endText)}</p>
        <div class="row">
          <button class="btn small" data-action="copy-story">Copy</button>
          <button class="btn small" data-action="download-story">Download .txt</button>
          ${navigator.share ? '<button class="btn small" data-action="share-story">Share</button>' : ''}
        </div>
        <p class="next">Next story in <span class="timer inline" data-deadline="${s.deadline}"></span>${
          s.nextSetterNick ? `. ${esc(s.nextSetterNick)} picks the theme.` : ''
        }</p>
      </section>
      ${scoreboardCardHtml(s)}`;
  }

  function afterBuild(s) {
    if (s.phase === 'writing') {
      const roundKey = `${s.story.index}:${s.round.index}`;
      if (app.draftKey !== roundKey) {
        app.draftKey = roundKey;
        app.draft = s.round.mine || '';
      }
      const ta = $('#sentence');
      if (ta) {
        ta.value = app.draft;
        updateChars(ta);
      }
    }
    if (s.phase === 'theme' && s.story.setterId === s.youId) {
      const input = $('#theme');
      if (input && !app.themeDraft) input.focus({ preventScroll: true });
    }
  }

  function patch(s) {
    const players = screenEl.querySelector('[data-players]');
    if (players) players.innerHTML = playersHtml(s);
    if (s.phase === 'writing') {
      const sub = screenEl.querySelector('[data-submitted]');
      if (sub) sub.textContent = submittedHtml(s);
      const status = screenEl.querySelector('[data-my-status]');
      if (status) status.textContent = myStatusHtml(s);
      const btn = screenEl.querySelector('[data-submit]');
      if (btn) btn.textContent = s.round.mine ? 'Update' : 'Submit';
      const mix = screenEl.querySelector('[data-mix]');
      if (mix) mix.innerHTML = mixChipsHtml(s.story.weights);
      const sliders = screenEl.querySelector('[data-sliders]');
      if (sliders && !sliders.contains(document.activeElement)) sliders.outerHTML = slidersHtml(s.story.weights);
    }
    if (s.phase === 'reveal' && s.results) {
      const counts = s.results.tapCounts || [];
      const max = Math.max(0, ...counts);
      screenEl.querySelectorAll('[data-podium] > .result').forEach((card, i) => {
        const badge = card.querySelector('[data-tapcount]');
        const favorite = max > 0 && counts[i] === max;
        if (badge) badge.outerHTML = tapBadgeHtml(counts[i] || 0, favorite);
        const mine = s.results.myTap === i;
        card.classList.toggle('tapped', mine);
        const mark = card.querySelector('[data-mypick]');
        if (mark) mark.hidden = !mine;
        if (card.classList.contains('tappable')) card.title = mine ? 'Your pick. Tap again to clear it.' : 'Tap to make this your pick';
      });
    }
    screenEl.querySelectorAll('[data-bar]').forEach((b) => (b.dataset.bar = s.deadline || ''));
    screenEl.querySelectorAll('[data-deadline]').forEach((el) => (el.dataset.deadline = s.deadline || ''));
  }

  function renderDrawer(s) {
    drawer.hidden = !app.drawerOpen;
    if (!app.drawerOpen || !s) return;
    const setterId = s.story ? s.story.setterId : null;
    const sorted = [...s.players].sort((a, b) => b.score - a.score);
    $('#drawer-list').innerHTML = sorted
      .map(
        (p) =>
          `<li><span class="dot ${p.connected ? '' : 'off'}"></span>${esc(p.nick)}${p.id === setterId ? '<span class="badge jev">theme</span>' : ''}${
            p.id === s.youId ? '<span class="badge you">you</span>' : ''
          }<span class="pts">${p.score}</span></li>`,
      )
      .join('');
    const fb = s.feedback || { rounds: 0, taps: 0, agreements: 0 };
    const agree = fb.taps ? `${Math.round((fb.agreements / fb.taps) * 100)}%` : 'no taps yet';
    $('#drawer-jev').innerHTML = `
      <h3>Jev and this room</h3>
      <p class="muted small">Players agreed with Jev's pick ${esc(agree)}${fb.taps ? ` of the time across ${fb.taps} ${fb.taps === 1 ? 'tap' : 'taps'}` : ''}. Taps nudge the defaults below.</p>
      <div class="label">Default taste</div>
      <div class="chips">${mixChipsHtml(s.learned)}</div>`;
  }

  // ----------------------------------------------------------------- timer
  function tick() {
    const now = Date.now() + app.clockOffset;
    document.querySelectorAll('[data-deadline]').forEach((el) => {
      const dl = Number(el.dataset.deadline);
      if (!dl) {
        el.textContent = '';
        return;
      }
      const sec = Math.max(0, Math.ceil((dl - now) / 1000));
      el.textContent = sec >= 60 ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` : `${sec}s`;
      el.classList.toggle('urgent', sec <= 10);
    });
    document.querySelectorAll('[data-bar]').forEach((el) => {
      const dl = Number(el.dataset.bar);
      const total = Number(el.dataset.total) || 1;
      const frac = dl ? Math.max(0, Math.min(1, (dl - now) / total)) : 0;
      if (el.firstElementChild) el.firstElementChild.style.width = `${frac * 100}%`;
    });
  }
  setInterval(tick, 250);

  // --------------------------------------------------------------- helpers
  function updateChars(ta) {
    const el = screenEl.querySelector('[data-chars]');
    if (el) el.textContent = `${ta.value.length}/${ta.maxLength > 0 ? ta.maxLength : 280}`;
  }

  function readSliders(container) {
    const w = {};
    container.querySelectorAll('[data-dim]').forEach((inp) => (w[inp.dataset.dim] = Number(inp.value)));
    return w;
  }

  function refreshSliderLabels(container) {
    const p = weightsPct(readSliders(container));
    container.querySelectorAll('[data-pct]').forEach((b) => (b.textContent = pct(p[b.dataset.pct])));
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* fall through */
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  function inviteLink() {
    const room = roomByCode(app.code);
    return `${location.origin}/${room ? room.slug : ''}`;
  }

  function downloadText(name, text) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function slug(text) {
    return (
      String(text || 'story')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'story'
    );
  }

  // --------------------------------------------------------------- actions
  async function handleAction(action, btn) {
    const s = app.state;
    switch (action) {
      case 'join':
        return joinFromHome(btn.dataset.code);
      case 'retry':
        app.retries = 0;
        if (!app.ws) openSocket();
        return;
      case 'copy-link': {
        const ok = await copyText(inviteLink());
        toast(ok ? `Invite link copied: ${inviteLink()}` : `Invite link: ${inviteLink()}`);
        return;
      }
      case 'toggle-scores':
        app.drawerOpen = !app.drawerOpen;
        renderDrawer(s);
        return;
      case 'ask-leave':
        leaveDialog.showModal();
        return;
      case 'cancel-leave':
        leaveDialog.close();
        return;
      case 'confirm-leave':
        leaveDialog.close();
        leaveRoom();
        return;
      case 'pick-len': {
        app.lenDraft = btn.dataset.len;
        screenEl.querySelectorAll('[data-len]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.len === app.lenDraft)));
        return;
      }
      case 'set-theme': {
        const input = $('#theme');
        const theme = ((input && input.value) || '').trim();
        if (!theme) return toast('Write a theme first.');
        const sliders = screenEl.querySelector('[data-sliders]');
        send({ type: 'theme', theme, length: app.lenDraft, weights: sliders ? readSliders(sliders) : undefined });
        return;
      }
      case 'submit': {
        const ta = $('#sentence');
        const text = ((ta && ta.value) || '').trim();
        if (!text) return toast('Write a sentence first.');
        app.draft = text;
        send({ type: 'sentence', text });
        return;
      }
      case 'tap':
        send({ type: 'tap', index: Number(btn.dataset.index) });
        return;
      case 'skip':
        send({ type: 'skip' });
        return;
      case 'copy-story': {
        const ok = await copyText(storyText(s.lastStory));
        toast(ok ? 'Story copied.' : 'Copy failed. Try Download instead.');
        return;
      }
      case 'download-story':
        downloadText(`jev-story-${slug(s.lastStory.theme)}.txt`, storyText(s.lastStory));
        return;
      case 'share-story':
        try {
          await navigator.share({ title: s.lastStory.theme, text: storyText(s.lastStory) });
        } catch {
          /* cancelled */
        }
        return;
      default:
        return;
    }
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    handleAction(btn.dataset.action, btn);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const t = e.target;
    if (t.matches && t.matches('[data-action="tap"]')) {
      e.preventDefault();
      handleAction('tap', t);
    } else if (t.id === 'theme') {
      e.preventDefault();
      handleAction('set-theme');
    } else if (t.id === 'sentence' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleAction('submit');
    }
  });

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'sentence') {
      app.draft = t.value;
      updateChars(t);
      const status = screenEl.querySelector('[data-my-status]');
      if (status && app.state) status.textContent = myStatusHtml(app.state);
    } else if (t.id === 'theme') {
      app.themeDraft = t.value;
    } else if (t.matches('[data-dim]')) {
      refreshSliderLabels(t.closest('[data-sliders]'));
    }
  });

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('[data-dim]')) send({ type: 'weights', weights: readSliders(t.closest('[data-sliders]')) });
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }

  // ------------------------------------------------------------------ boot
  const urlCode = codeFromUrl();
  const cached = urlCode ? loadIdentity(urlCode) : null;
  if (urlCode && cached && cached.token) {
    // A refresh mid-game goes straight back to the seat.
    enterRoom(urlCode, cached.nick, cached.token);
  } else {
    render();
    refreshRooms();
  }
})();
