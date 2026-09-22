/* Jev Yarn client. One file, no framework. The server owns all game
   state; this file renders snapshots and sends intents. */
(() => {
  'use strict';

  const LENGTHS = {
    short: { label: 'Short', min: 4, max: 7 },
    medium: { label: 'Medium', min: 7, max: 12 },
    long: { label: 'Long', min: 12, max: 18 },
  };
  // Length settings by key; anything that is not a story length reads as medium.
  const lengthInfo = (key) => (Object.hasOwn(LENGTHS, key) ? LENGTHS[key] : LENGTHS.medium);
  const DIMS = [
    { key: 'funny', label: 'Funny', help: 'Wit, absurdity, timing' },
    { key: 'continuity', label: 'Flows', help: 'Follows the story so far' },
    { key: 'theme', label: 'On theme', help: 'Belongs to the theme' },
    { key: 'surprise', label: 'Surprising', help: 'Twists and wild imagery' },
  ];
  // Display fallback until /api/rooms answers.
  const ROOMS = [
    {
      code: 'E',
      label: 'Safe for Everyone',
      slug: 'safe-for-everyone',
      aliases: ['everyone'],
      tagline: 'Clean fun for all ages',
      filters: ['violence', 'sexual content', 'swearing', 'hate and harassment'],
      players: 0,
    },
    {
      code: 'T',
      label: 'Moderated for Teens',
      slug: 'moderated-for-teens',
      aliases: ['teen', 'teens'],
      tagline: 'Mild language and cartoon mayhem are fine',
      filters: ['graphic violence', 'explicit sexual content', 'strong profanity', 'hate and harassment'],
      players: 0,
    },
    {
      code: 'M',
      label: 'Mature Audience Only',
      slug: 'mature-audience-only',
      aliases: ['mature'],
      tagline: 'Strong language and adult humor allowed',
      filters: ['pornographic description', 'hate and harassment'],
      players: 0,
    },
    {
      code: 'A',
      label: 'Absolute Degenerates',
      slug: 'absolute-degenerates',
      aliases: ['adult', 'degenerates'],
      tagline: 'Anything goes',
      filters: [],
      players: 0,
    },
  ];

  // Player icons: same list and order as the server (src/rules.js).
  const EMOJIS = [
    0x1f98a, 0x1f438, 0x1f419, 0x1f989, 0x1f422, 0x1f984, 0x1f41d, 0x1f427,
    0x1f996, 0x1f433, 0x1f98b, 0x1f43c, 0x1f42f, 0x1f981, 0x1f428, 0x1f430,
    0x1f43b, 0x1f435, 0x1f99c, 0x1f9a9, 0x1f40c, 0x1f344, 0x1f335, 0x1f680,
    0x1f431, 0x1f436, 0x1f980, 0x1f986, 0x1f994, 0x1f47b, 0x1f916, 0x1f47d,
  ].map((c) => String.fromCodePoint(c));

  // Inside Discord the game runs as an Activity. Discord puts frame_id and
  // instance_id in the page address, and everyone in the same call shares the
  // instance, which gets its own private set of rooms.
  const launch = new URLSearchParams(location.search);
  const DISCORD = launch.has('frame_id') && launch.has('instance_id');
  const discord = { instanceId: DISCORD ? launch.get('instance_id') : null, sdk: null };

  const $ = (sel, root = document) => root.querySelector(sel);
  const screenEl = $('#screen');
  const topbar = $('#topbar');
  const connEl = $('#conn');
  const drawer = $('#drawer');
  const toastEl = $('#toast');
  const leaveDialog = $('#leave-dialog');
  const endDialog = $('#end-dialog');

  const esc = (v) =>
    String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const pct = (x) => `${Math.round((Number(x) || 0) * 100)}%`;
  const av = (e) => (e ? `<span class="av" aria-hidden="true">${esc(e)}</span>` : '');
  // Green while the player is here; grey when disconnected or in the background.
  const dotHtml = (p) => `<span class="dot ${p.connected && !p.away ? '' : 'off'}"></span>`;

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
  // Seats are remembered per room, and inside Discord per call as well.
  const roomKey = (code) => (DISCORD ? `${discord.instanceId}:${code}` : code);
  const identityKey = (code) => `jev:room:${roomKey(code)}`;
  const lastRoomKey = () => (DISCORD ? `jev:lastRoom:${discord.instanceId}` : 'jev:lastRoom');
  // Inside Discord every request names the call, whose private rooms it wants.
  const instanceQuery = () => (DISCORD ? `?instance=${encodeURIComponent(discord.instanceId)}` : '');
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
    emoji: null,
    busy: false,
    code: null,
    nick: '',
    token: null,
    me: null,
    ws: null,
    want: false,
    lastPong: 0,
    sentAway: false,
    typedKey: null,
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
    const s = String(slug || '').toLowerCase();
    return app.rooms.find((r) => r.slug === s || (r.aliases || []).includes(s)) || null;
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
      ws = new WebSocket(`${proto}://${location.host}/ws/${app.code}${instanceQuery()}`);
    } catch {
      scheduleReconnect();
      return;
    }
    app.ws = ws;
    ws.addEventListener('open', () => {
      app.lastPong = Date.now();
      ws.send(JSON.stringify({ type: 'join', nick: app.nick, token: app.token, emoji: app.emoji }));
    });
    ws.addEventListener('message', (ev) => {
      if (ev.data === 'pong') {
        app.lastPong = Date.now();
        return;
      }
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

  // The server answers every ping with a pong. A connection that has stopped
  // answering (a phone that changed networks, say) is closed here, so the
  // usual reconnect takes over instead of the game looking frozen.
  const PING_MS = 25000;
  const PONG_TIMEOUT_MS = 65000;
  function checkLiveness() {
    if (!app.ws || app.ws.readyState !== WebSocket.OPEN) return;
    if (app.lastPong && Date.now() - app.lastPong > PONG_TIMEOUT_MS) {
      app.ws.close();
      return;
    }
    app.ws.send('ping');
  }
  setInterval(checkLiveness, PING_MS);

  // Tells the room when this page goes to the background and comes back: a
  // player who is away does not hold up a round the others have finished.
  function reportAway() {
    if (!app.ws || app.ws.readyState !== WebSocket.OPEN || !app.me) return;
    const away = document.visibilityState === 'hidden';
    if (away === app.sentAway) return;
    app.sentAway = away;
    app.ws.send(JSON.stringify({ type: 'away', away }));
  }

  // The first keystroke of a round tells the room this player is writing, so
  // a player who sat out the last round is waited for again.
  function noteTyping() {
    const s = app.state;
    if (!s || s.phase !== 'writing' || !s.round || !s.story) return;
    const key = [s.story.index, s.story.theme, s.round.index, s.round.attempts].join('|');
    if (app.typedKey === key || !app.ws || app.ws.readyState !== WebSocket.OPEN) return;
    app.typedKey = key;
    app.ws.send(JSON.stringify({ type: 'typing' }));
  }

  document.addEventListener('visibilitychange', () => {
    reportAway();
    if (document.visibilityState !== 'visible' || !app.ws || app.ws.readyState !== WebSocket.OPEN) return;
    // Back from the background: ask right away, and give up on a connection
    // that does not answer within a few seconds.
    const asked = Date.now();
    app.ws.send('ping');
    setTimeout(() => {
      if (app.ws && app.ws.readyState === WebSocket.OPEN && app.lastPong < asked) app.ws.close();
    }, 5000);
  });

  function handleMessage(msg) {
    switch (msg.type) {
      case 'joined':
        app.me = { id: msg.playerId, nick: msg.nick };
        app.token = msg.token;
        app.nick = msg.nick;
        app.retries = 0;
        app.connLost = false;
        saveIdentity(app.code, { token: msg.token, nick: msg.nick });
        store.set(lastRoomKey(), app.code);
        // The server starts every connection as present; say so if this page is hidden.
        app.sentAway = false;
        reportAway();
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
    // Inside Discord the address carries Discord's launch details: keep it.
    if (!DISCORD) history.replaceState(null, '', `/${room.slug}`);
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
      if (store.get(lastRoomKey()) === app.code) store.del(lastRoomKey());
    }
    Object.assign(app, { screen: 'home', state: null, me: null, token: null, code: null, drawerOpen: false, connLost: false });
    if (!DISCORD) history.replaceState(null, '', '/');
    if (endDialog.open) endDialog.close();
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
      const res = await fetch(`/api/rooms${instanceQuery()}`, { cache: 'no-store' });
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
    $('#tb-room').textContent = room ? room.label : 'Room';
    const s = app.state;
    if (!s) {
      $('#tb-count').textContent = '';
      $('#tb-story').textContent = '';
      screenEl.innerHTML = `<section class="card center"><div class="spinner"></div><p class="muted">Joining ${esc(
        room ? room.label : 'the room',
      )}…</p>${app.retries > 4 ? '<button class="btn" data-action="retry">Try again</button>' : ''}</section>`;
      return;
    }
    // A confirmation left open after the reveal has moved on no longer applies.
    if (endDialog.open && (s.phase !== 'reveal' || !s.story || s.story.setterId !== s.youId)) endDialog.close();
    const me = s.players.find((p) => p.id === s.youId) || null;
    const connected = s.players.filter((p) => p.connected).length;
    $('#tb-count').textContent = `${connected} ${connected === 1 ? 'player' : 'players'}`;
    $('#tb-story').textContent =
      s.story && s.story.theme ? s.story.theme : '';

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
        <h1>Jev Yarn</h1>
        <img class="logo" src="/icons/icon-512.png" alt="" width="128" height="128">
        <p class="tagline">Everyone writes the next line. Jev picks the winner.</p>
      </section>
      <section class="card stack">
        <label for="nick" class="step">1. Pick an icon and submit a nickname</label>
        <div class="nick-row">
          ${emojiPickerHtml('emoji-home')}
          <input id="nick" maxlength="20" autocomplete="nickname" placeholder="e.g. Captain Goose" value="${esc(savedNick)}">
        </div>
        <div class="step step-gap">2. Choose a room</div>
        <div id="room-cards" class="room-list">${roomCardsHtml()}</div>
        <p class="error" id="home-error">${esc(app.homeError)}</p>
      </section>
      <section class="how">
        <h2>How to play</h2>
        <ol>
          <li><b>Take turns setting a theme.</b> The theme setter picks a length and tunes what Jev rewards.</li>
          <li><b>Everyone writes the next line.</b> One sentence each, against the clock.</li>
          <li><b>Jev picks.</b> TypeSafe's Jev reads every line and the funniest one joins the story. One point to its author.</li>
          <li><b>Tap your favorite.</b> Taps never change the pick, but they teach Jev what the room enjoys.</li>
          <li><b>Jev also decides when the story is done, and scores it.</b> Then the next player sets a theme, for as long as two of you are here.</li>
        </ol>
      </section>`;
  }

  // The icon itself is the control: each tap moves to the next one and the
  // list wraps around.
  function emojiPickerHtml(id) {
    return `<button type="button" class="emoji-pick emoji-cur" id="${id}" data-action="emoji-next" data-emoji-current title="Tap to change your icon" aria-label="Your icon. Tap to change it.">${esc(
      app.emoji,
    )}</button>`;
  }

  // ----------------------------------------------------------- fragments
  function playersHtml(s) {
    return `<ul class="players">${s.players
      .map(
        (p) =>
          `<li>${dotHtml(p)}${av(p.emoji)}${esc(p.nick)}${p.id === s.youId ? '<span class="badge you">you</span>' : ''}</li>`,
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
          `<li data-n="${i + 1}" class="${highlightLast && i === story.sentences.length - 1 ? 'new' : ''}">${esc(x.text)}<span class="by">${av(
            x.authorEmoji,
          )}${esc(x.authorNick)}</span></li>`,
      )
      .join('')}</ol>`;
  }

  function storyPanelHtml(s, highlightLast) {
    const st = s.story;
    if (!st) return '';
    const len = lengthInfo(st.length);
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
          `<li>${dotHtml(p)}${av(p.emoji)}${esc(p.nick)}${p.id === s.youId ? '<span class="badge you">you</span>' : ''}<span class="pts">${p.score}</span></li>`,
      )
      .join('')}</ol>${s.players.length > 10 ? `<p class="hint">and ${s.players.length - 10} more, see Scores in the top bar</p>` : ''}</section>`;
  }

  // Counts those who have written plus those the round still waits for; the
  // server leaves out players who are away or sat the last round out.
  function submittedHtml(s) {
    const r = s.round || {};
    const total = Number.isFinite(r.writerCount) ? r.writerCount : s.players.filter((p) => p.connected).length;
    const n = Number.isFinite(r.writtenCount) ? r.writtenCount : r.submittedCount || 0;
    return `${n} of ${total} ${total === 1 ? 'player has' : 'players have'} written`;
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
        <p class="muted">The game starts as soon as two or more people are in the room.</p>
        ${DISCORD ? '' : '<button class="btn primary" data-action="copy-link">Copy invite link</button>'}
        <div style="margin-top:16px" data-players>${playersHtml(s)}</div>
      </section>
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
          <p class="muted small" style="margin-top:10px">Provide a theme for this story. Pick its length and tune how Jev judges responses.</p>
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
        <h2>${av(st.setterEmoji)}${esc(st.setterNick)} is choosing a theme</h2>
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
        <textarea id="sentence" maxlength="${s.settings.maxSentenceChars}" rows="3" enterkeyhint="send" placeholder="${
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
    const cls = ['result', rank === 0 ? 'winner wobble' : '', own ? 'own' : 'tappable', tapped ? 'tapped' : ''].join(' ');
    const label = rank === 0 ? 'Jev picked' : `#${rank + 1}`;
    return `<article class="${cls}" ${own ? '' : `data-action="tap" data-index="${rank}"`} role="${own ? '' : 'button'}" tabindex="${own ? -1 : 0}" title="${
      own ? 'Your own line' : tapped ? 'Your pick. Tap again to clear it.' : 'Tap to make this your pick'
    }">
      <div class="rank"><span class="rank-label">${label}</span>${own ? ' · yours' : ''}<span class="mypick" data-mypick ${tapped ? '' : 'hidden'}> · your pick</span></div>
      <p class="text">${esc(row.text)}</p>
      <div class="meta"><span class="author">by ${av(row.authorEmoji)}${esc(row.authorNick)}</span><span class="share">${pct(row.share)}</span></div>
      ${dimsHtml(row)}
      ${tapBadgeHtml(counts[rank] || 0, favorite)}
    </article>`;
  }

  function buildReveal(s, me) {
    const res = s.results || {};
    const top = res.top || [];
    const others = res.others || [];
    // Only your own filtered line travels to you; the rest is a count.
    const filtered = res.filtered || [];
    const filteredCount = Number(res.filteredCount) || filtered.length;
    const mine = filtered[0] || null;
    const hasWinner = Boolean(res.winnerId);
    const isSetter = s.story && s.story.setterId === s.youId;
    // The setter may end the story once it has a line, unless Jev is already ending it.
    const canEnd = Boolean(s.story && s.story.sentences.length > 0 && !res.ends);
    let next;
    if (!hasWinner) next = `Trying again in <span class="timer inline" data-deadline="${s.deadline}"></span>`;
    else if (res.ends) next = `The story is complete. Reading it in <span class="timer inline" data-deadline="${s.deadline}"></span>`;
    else next = `Next line in <span class="timer inline" data-deadline="${s.deadline}"></span>`;

    return `
      <section class="card">
        <div class="row between"><h2>${hasWinner ? 'Jev has spoken' : 'No winner this round'}</h2>${
          isSetter
            ? `<div class="row setter-actions">${
                canEnd ? '<button class="btn small ghost" data-action="ask-end-story">End the story</button>' : ''
              }<button class="btn small" data-action="skip">Skip ahead</button></div>`
            : ''
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
                .map(
                  (r) =>
                    `<article class="result"><p class="text">${esc(r.text)}</p><div class="meta"><span>by ${av(r.authorEmoji)}${esc(r.authorNick)}</span><span class="share">${pct(
                      r.share,
                    )}</span></div></article>`,
                )
                .join('')}${
                (res.othersTotal || 0) > others.length ? `<p class="hint">and ${res.othersTotal - others.length} more lines below these</p>` : ''
              }</div></details>`
            : ''
        }
        ${
          filteredCount
            ? `<p class="hint" style="margin-top:10px">${filteredCount} ${filteredCount === 1 ? 'line was' : 'lines were'} filtered for this room.${
                mine ? ` Yours was one of them (${esc((mine.flags || []).join(', '))}).` : ''
              }</p>`
            : ''
        }
        <p class="next">${next}</p>
      </section>
      ${storyPanelHtml(s, hasWinner)}`;
  }

  function storyText(st) {
    const len = lengthInfo(st.length);
    const who = (emoji, nick) => `${emoji ? `${emoji} ` : ''}${nick}`;
    const lines = st.sentences.map((x, i) => `${i + 1}. ${x.text}  (${who(x.authorEmoji, x.authorNick)})`);
    const js = st.jevScore;
    const score =
      js && js.dims ? `Jev's score: ${js.overall}/100 (${DIMS.map((d) => `${d.label} ${pct(js.dims[d.key].value)}`).join(', ')})\n` : '';
    return `${st.theme}\nA Jev Yarn tale,${len.label.toLowerCase()} length, theme by ${who(st.setterEmoji, st.setterNick)}\n\n${lines.join(
      '\n',
    )}\n\n${st.endText || ''}\n${score}`;
  }

  // Jev's score for a finished story: an overall mark plus the four qualities.
  function verdictHtml(js) {
    if (!js || js.pending) return '<div class="verdict pending"><div class="spinner small"></div><span class="muted">Jev is scoring the story…</span></div>';
    if (js.error || !js.dims) return `<p class="muted small">${esc(js.error || 'Jev could not score this story.')}</p>`;
    return `<div class="verdict">
      <div class="verdict-head"><span class="label">Jev's score</span><span class="verdict-num"><b>${Number(js.overall) || 0}</b>/100</span></div>
      <div class="dims story-dims">${DIMS.map((d) => {
        const v = js.dims[d.key] || { value: 0, label: '' };
        return `<div class="dim">${d.label}<span class="dim-level">${esc(v.label)}</span><i><b style="width:${Math.round((Number(v.value) || 0) * 100)}%"></b></i></div>`;
      }).join('')}</div>
    </div>`;
  }

  function buildStoryEnd(s) {
    const st = s.lastStory;
    if (!st) return '<section class="card"><p>Loading the story…</p></section>';
    const len = lengthInfo(st.length);
    return `
      <section class="card story-final">
        <div class="label">${len.label} · theme by ${av(st.setterEmoji)}${esc(st.setterNick)}</div>
        <h2>${esc(st.theme)}</h2>
        <ol class="story final">${st.sentences
          .map((x, i) => `<li data-n="${i + 1}">${esc(x.text)}<span class="by">${av(x.authorEmoji)}${esc(x.authorNick)}</span></li>`)
          .join('')}</ol>
        <p class="muted" style="margin-top:12px">${esc(st.endText)}</p>
        ${verdictHtml(st.jevScore)}
        <div class="row">
          <button class="btn small" data-action="copy-story">Copy</button>
          <button class="btn small" data-action="download-story">Download .txt</button>
          ${navigator.share ? '<button class="btn small" data-action="share-story">Share</button>' : ''}
        </div>
        <p class="next">Next story in <span class="timer inline" data-deadline="${s.deadline}"></span>${
          s.nextSetterNick ? `. ${av(s.nextSetterEmoji)}${esc(s.nextSetterNick)} picks the theme.` : ''
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

  // Pie of Jev's four judging weights. Slices run clockwise from 12 o'clock in
  // the fixed dimension order, each colour tied to its dimension; every slice
  // is labelled with its name and share, so colour never carries identity alone.
  function pieHtml(weights) {
    const p = weightsPct(weights);
    const slices = DIMS.map((d, i) => ({ d, frac: p[d.key], color: `var(--series-${i + 1})` })).filter((x) => x.frac > 0);
    const W = 320;
    const H = 172;
    const cx = W / 2;
    const cy = H / 2;
    const r = 56;
    const lr = 64;
    const at = (ang, rad) => [cx + rad * Math.sin(ang), cy - rad * Math.cos(ang)];
    const marks = [];
    const labels = [];
    let a = 0;
    for (const s of slices) {
      const a0 = a;
      const a1 = a + s.frac * 2 * Math.PI;
      a = a1;
      const title = `<title>${esc(`${s.d.label} ${pct(s.frac)}`)}</title>`;
      if (slices.length === 1) {
        marks.push(`<circle cx="${cx}" cy="${cy}" r="${r}" style="fill:${s.color}">${title}</circle>`);
      } else {
        const [x0, y0] = at(a0, r);
        const [x1, y1] = at(a1, r);
        const large = a1 - a0 > Math.PI ? 1 : 0;
        marks.push(
          `<path d="M${cx},${cy} L${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)} Z" style="fill:${s.color}">${title}</path>`,
        );
      }
      const mid = (a0 + a1) / 2;
      const [lx, ly] = at(mid, lr);
      labels.push({ x: lx, y: ly, right: Math.sin(mid) >= 0, name: s.d.label, value: pct(s.frac) });
    }
    // Keep labels on each side at least one line apart.
    for (const side of [true, false]) {
      const group = labels.filter((l) => l.right === side).sort((m, n) => m.y - n.y);
      for (let i = 1; i < group.length; i++) if (group[i].y - group[i - 1].y < 15) group[i].y = group[i - 1].y + 15;
    }
    const text = labels
      .map(
        (l) =>
          `<text x="${(l.x + (l.right ? 4 : -4)).toFixed(1)}" y="${(l.y + 4).toFixed(1)}" text-anchor="${l.right ? 'start' : 'end'}" class="pie-label">${esc(
            l.name,
          )} <tspan class="pie-value">${esc(l.value)}</tspan></text>`,
      )
      .join('');
    const summary = slices.map((s) => `${s.d.label} ${pct(s.frac)}`).join(', ');
    return `<svg class="pie" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`Jev's judgement criteria: ${summary}`)}">${marks.join('')}${text}</svg>
      <ul class="pie-legend">${DIMS.map(
        (d, i) => `<li><span class="swatch" style="background:var(--series-${i + 1})"></span>${d.label}<b>${pct(p[d.key])}</b></li>`,
      ).join('')}</ul>`;
  }

  // How long a player has been in the room, from their join time.
  function sinceText(joinedAt) {
    const start = Number(joinedAt) || 0;
    if (!start) return '';
    const min = Math.floor(Math.max(0, Date.now() + app.clockOffset - start) / 60000);
    if (min < 1) return 'just joined';
    if (min < 60) return `playing ${min} min`;
    return `playing ${Math.floor(min / 60)} h ${min % 60} min`;
  }

  function renderDrawer(s) {
    drawer.hidden = !app.drawerOpen;
    if (!app.drawerOpen || !s) return;
    const setterId = s.story ? s.story.setterId : null;
    // The mix Jev uses right now: this story's sliders, else the room defaults.
    const weights = s.story && s.story.weights ? s.story.weights : s.learned;
    // Under the pie, say who set this story's mix, once they have set it. No
    // note for the room defaults or while the theme is still being chosen.
    const note =
      s.story && s.story.theme
        ? `<p class="muted small pie-note">Set by ${av(s.story.setterEmoji)}${esc(s.story.setterNick)} for this round.</p>`
        : '';
    $('#drawer-jev').innerHTML = pieHtml(weights) + note;
    // Your own row first, then everyone else from highest score to lowest.
    const me = s.players.find((p) => p.id === s.youId);
    const others = s.players.filter((p) => p.id !== s.youId).sort((a, b) => b.score - a.score || (a.joinedAt || 0) - (b.joinedAt || 0));
    const row = (p, mine) =>
      `<li class="${mine ? 'me' : ''}">${dotHtml(p)}${av(p.emoji)}<span class="who"><span class="who-name">${esc(
        p.nick,
      )}${p.id === setterId ? '<span class="badge jev">theme</span>' : ''}${mine ? '<span class="badge you">you</span>' : ''}</span><span class="since" data-since="${
        Number(p.joinedAt) || 0
      }">${sinceText(p.joinedAt)}</span></span><span class="pts">${p.score}</span></li>`;
    $('#drawer-list').innerHTML = (me ? row(me, true) : '') + others.map((p) => row(p, false)).join('');
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
    document.querySelectorAll('[data-since]').forEach((el) => {
      const t = sinceText(el.dataset.since);
      if (el.textContent !== t) el.textContent = t;
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
      case 'emoji-next': {
        // Icons are chosen on the home screen only; they are fixed once in a room.
        if (app.screen !== 'home') return;
        const i = Math.max(0, EMOJIS.indexOf(app.emoji));
        app.emoji = EMOJIS[(i + 1) % EMOJIS.length];
        store.set('jev:emoji', app.emoji);
        document.querySelectorAll('[data-emoji-current]').forEach((el) => (el.textContent = app.emoji));
        return;
      }
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
      case 'ask-end-story':
        endDialog.showModal();
        return;
      case 'cancel-end':
        endDialog.close();
        return;
      case 'confirm-end':
        endDialog.close();
        send({ type: 'end-story' });
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
    // Enter while an input method is still composing a character is not a submit.
    if (e.key !== 'Enter' || e.isComposing) return;
    const t = e.target;
    if (t.matches && t.matches('[data-action="tap"]')) {
      e.preventDefault();
      handleAction('tap', t);
    } else if (t.id === 'theme') {
      e.preventDefault();
      handleAction('set-theme');
    } else if (t.id === 'sentence' && !e.shiftKey) {
      // Enter is the same as tapping Submit.
      e.preventDefault();
      handleAction('submit');
    }
  });

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'sentence') {
      app.draft = t.value;
      updateChars(t);
      noteTyping();
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

  // Discord keeps its own copy of the page, so there is no offline shell there.
  if ('serviceWorker' in navigator && !DISCORD) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }

  // Discord's handshake. Its SDK is loaded only inside Discord, where the page
  // address names the app: <application id>.discordsays.com. A local run with
  // Discord's parameters but another address skips it.
  async function startDiscord() {
    const clientId = location.hostname.split('.')[0];
    if (!/^\d+$/.test(clientId)) return;
    try {
      const { DiscordSDK } = await import('/vendor/discord-sdk.js');
      discord.sdk = new DiscordSDK(clientId);
      await discord.sdk.ready();
    } catch (err) {
      console.error('Discord handshake failed', err);
    }
  }

  // ------------------------------------------------------------------ boot
  if (DISCORD) {
    startDiscord();
    // Invites happen in Discord itself: the room name is not a link to copy.
    const pill = $('.tb-code');
    pill.removeAttribute('data-action');
    pill.removeAttribute('title');
  }
  app.emoji = (() => {
    const saved = store.get('jev:emoji');
    if (saved && EMOJIS.includes(saved)) return saved;
    const pick = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
    store.set('jev:emoji', pick);
    return pick;
  })();
  // The room to go back to: the one in the address, or inside Discord (where
  // the address stays Discord's) the last one joined in this call.
  const lastCode = DISCORD ? store.get(lastRoomKey()) : null;
  const urlCode = DISCORD ? (roomByCode(lastCode) ? lastCode : null) : codeFromUrl();
  const cached = urlCode ? loadIdentity(urlCode) : null;
  if (urlCode && cached && cached.token) {
    // A refresh mid-game goes straight back to the seat.
    enterRoom(urlCode, cached.nick, cached.token);
  } else {
    render();
    refreshRooms();
  }
})();
