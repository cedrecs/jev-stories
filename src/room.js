// One Durable Object per room. Owns the players, the story, the phase timers
// (Durable Object alarms) and the WebSockets (hibernation API). Every mutation
// is persisted so the object can hibernate or restart without losing the game.
//
// Rooms are fixed (one per content rating) and have no host: the game runs
// whenever two players are present. Settings come from the deployment config.

import { DurableObject } from 'cloudflare:workers';
import {
  RATINGS,
  LIMITS,
  TOP_N,
  OTHERS_N,
  PROTOCOL_VERSION,
  defaultWeights,
  normalizeWeights,
  normalizeLength,
  settingsFromEnv,
  learnFromTaps,
  nextSetter,
  cleanText,
  pickEmoji,
  ipKey,
  RateLimiter,
} from './rules.js';
import { judgeRound, candidateId, scoreStory, checkText, UNCHECKED } from './judge.js';

const STORY_SCORE_ERROR = 'Jev could not score this story.';
const JUDGE_ERROR = 'Jev could not judge this round. The round will replay.';
const UNCHECKED_LABEL = 'could not be checked';

// An error whose message is meant for the player. Any other error is logged
// and the player sees a generic line instead of its text.
class GameError extends Error {}

const GRACE_MS = 60_000; // a dropped connection keeps its seat and score this long
const JUDGE_WATCHDOG_MS = 90_000; // judging older than this (a restart mid-judge) is run again
// Abuse limits per connection: the largest message that could be legitimate,
// a token bucket, and how many dropped messages close the connection. One
// network address may hold this many connections to a room.
const MAX_MESSAGE_CHARS = 8192;
const RATE_LIMIT = { burst: 30, perSecond: 3 };
const STRIKES_TO_CLOSE = 60;
const MAX_SOCKETS_PER_ADDRESS = 25;
const EMPTY_ROOM_SLEEP_MS = 60 * 60_000; // an hour after everyone is gone, clear the table
const MIN_RESUME_MS = 15_000; // when a paused phase resumes, give at least this long
const BROADCAST_COALESCE_MS = 200; // bursts of updates are sent at most this often
const ACTIVE_PHASES = new Set(['theme', 'writing', 'reveal', 'storyEnd']);

const END_REASON_TEXT = {
  jev: 'Jev felt the story had reached its ending.',
  max: 'The story reached the maximum length for its size.',
  abandoned: 'Nobody wrote a sentence, so the story was closed.',
};

function now() {
  return Date.now();
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.room = null;
    this.judging = false;
    this.lastBroadcastAt = 0;
    this.broadcastTimer = null;
    // The player roster is large with 100 seats, so snapshots carry it only
    // when it changed since the last broadcast (joins, leaves, scores).
    this.rosterDirty = true;
    // Per-connection abuse state (a token bucket and a strike count), and the
    // connections whose nickname or theme Jev is still checking.
    this.limits = new WeakMap();
    this.busy = new WeakSet();
    this.ctx.blockConcurrencyWhile(async () => {
      this.room = (await this.ctx.storage.get('room')) || null;
      if (this.room) await this.migrate();
    });
    // Cheap keepalive that does not wake a hibernating object.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  // Older persisted rooms get the fields newer code expects; settings always
  // follow the current deployment config.
  async migrate() {
    const r = this.room;
    r.settings = settingsFromEnv(this.env);
    r.learned = normalizeWeights(r.learned);
    r.feedback = r.feedback || { rounds: 0, taps: 0, agreements: 0 };
    if (r.phase === 'lobby') {
      r.phase = 'paused';
      r.paused = { phase: 'theme', remainingMs: 0 };
    }
    if (r.results && !r.results.taps) r.results.taps = {};
    for (const p of Object.values(r.players)) if (!p.emoji) p.emoji = pickEmoji(null, p.order);
    // A restart while Jev was scoring the last story leaves it pending forever.
    if (r.lastStory && r.lastStory.jevScore && r.lastStory.jevScore.pending) r.lastStory.jevScore = { error: STORY_SCORE_ERROR };
    // A restart while Jev was judging: the watchdog alarm judges the round again.
    if (r.phase === 'judging') {
      if (!r.judgingSince) r.judgingSince = 0;
      await this.scheduleAlarm();
    }
  }

  rating() {
    return RATINGS[this.room.code] || RATINGS.E;
  }

  // ------------------------------------------------------------------ RPC

  async create(code) {
    if (!this.room) {
      this.room = {
        code,
        createdAt: now(),
        phase: 'paused',
        deadline: null,
        paused: { phase: 'theme', remainingMs: 0 },
        players: {},
        nextOrder: 1,
        settings: settingsFromEnv(this.env),
        storyCount: 0,
        story: null,
        round: null,
        results: null,
        lastStory: null,
        lastSetterOrder: 0,
        emptySince: now(),
        learned: defaultWeights(),
        feedback: { rounds: 0, taps: 0, agreements: 0 },
      };
      await this.save();
      await this.scheduleAlarm();
    }
    return { ok: true, code: this.room.code };
  }

  async info() {
    if (!this.room) return { exists: false };
    return {
      exists: true,
      code: this.room.code,
      phase: this.room.phase,
      // Counted from live connections, so a stale seat never shows as playing.
      players: this.livePlayerIds().size,
      seats: Object.keys(this.room.players).length,
    };
  }

  // ------------------------------------------------------------ WebSocket

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    if (!this.room) return new Response('Room not found', { status: 404 });
    // One network address may hold only so many connections, so a single
    // machine cannot fill a room with seats.
    const address = ipKey(request.headers.get('CF-Connecting-IP'));
    if (address) {
      const same = this.ctx.getWebSockets().filter((s) => s.readyState === WebSocket.OPEN && (s.deserializeAttachment() || {}).address === address);
      if (same.length >= MAX_SOCKETS_PER_ADDRESS) return new Response('Too many connections from this address', { status: 429 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ playerId: null, address });
    return new Response(null, { status: 101, webSocket: client });
  }

  // The attachment survives hibernation; patches keep its other fields.
  setAttachment(ws, patch) {
    ws.serializeAttachment({ ...(ws.deserializeAttachment() || {}), ...patch });
  }

  // Ids of the players who have an open connection right now.
  livePlayerIds(except = null) {
    const live = new Set();
    for (const s of this.ctx.getWebSockets()) {
      if (s === except || s.readyState !== WebSocket.OPEN) continue;
      const a = s.deserializeAttachment() || {};
      if (a.playerId && this.room.players[a.playerId]) live.add(a.playerId);
    }
    return live;
  }

  // Presence follows live connections: a seat whose connection is gone is
  // disconnected and its grace period starts, whatever the saved flag says.
  // This is what clears a seat left behind by a connection that never
  // closed cleanly. Returns whether anything changed.
  reconcilePresence(except = null) {
    const live = this.livePlayerIds(except);
    let changed = false;
    for (const p of Object.values(this.room.players)) {
      const on = live.has(p.id);
      if (p.connected === on) continue;
      p.connected = on;
      if (!on) p.lastSeen = now();
      changed = true;
    }
    if (changed) this.rosterDirty = true;
    return changed;
  }

  async webSocketMessage(ws, raw) {
    if (!this.room) return this.safeSend(ws, { type: 'error', message: 'This room is not available.', fatal: true });
    // Only a small text frame can be a real message; anything else is dropped
    // before it is even parsed.
    if (typeof raw !== 'string') return this.drop(ws, 1003, 'Text frames only');
    if (raw.length > MAX_MESSAGE_CHARS) return this.drop(ws, 1009, 'Message too big');
    const verdict = this.allow(ws);
    if (verdict === 'close') return this.drop(ws, 1008, 'Too many messages');
    if (verdict !== 'ok') return;
    let msg = null;
    try {
      msg = JSON.parse(raw);
    } catch {
      /* not JSON */
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') {
      return this.safeSend(ws, { type: 'error', message: 'Bad message' });
    }
    try {
      await this.handle(ws, msg);
    } catch (err) {
      if (err instanceof GameError) return this.safeSend(ws, { type: 'error', message: err.message });
      console.error('handle failed', err);
      this.safeSend(ws, { type: 'error', message: 'Something went wrong' });
    }
  }

  // Token bucket per connection. Over the limit a message is dropped without
  // a reply; a connection that keeps flooding is closed.
  allow(ws) {
    let entry = this.limits.get(ws);
    if (!entry) {
      entry = { limiter: new RateLimiter(RATE_LIMIT), strikes: 0 };
      this.limits.set(ws, entry);
    }
    if (entry.limiter.allow()) return 'ok';
    entry.strikes += 1;
    return entry.strikes >= STRIKES_TO_CLOSE ? 'close' : 'drop';
  }

  // Closes a connection that broke the rules and frees its seat like any
  // other lost connection.
  async drop(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {
      /* already closed */
    }
    await this.onSocketGone(ws);
  }

  async webSocketClose(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {
      /* already closed */
    }
    await this.onSocketGone(ws);
  }

  async webSocketError(ws) {
    await this.onSocketGone(ws);
  }

  async onSocketGone(ws) {
    if (!this.room) return;
    const att = ws.deserializeAttachment() || {};
    const p = att.playerId && this.room.players[att.playerId];
    if (!p) return;
    // Another live socket may still belong to this player (e.g. a refresh raced).
    const stillOpen = this.ctx.getWebSockets().some((other) => {
      if (other === ws) return false;
      const a = other.deserializeAttachment() || {};
      return a.playerId === p.id && other.readyState === WebSocket.OPEN;
    });
    if (stillOpen) return;
    p.connected = false;
    p.lastSeen = now();
    this.reconcilePresence(ws);
    if (this.connectedPlayers().length === 0) {
      this.room.emptySince = now();
      // The last person has gone (closed the tab or dropped): the next people
      // to arrive start a fresh story.
      this.resetStory();
    }
    this.rosterDirty = true;
    await this.afterPlayerChange();
  }

  // ------------------------------------------------------------- Messages

  async handle(ws, msg) {
    const att = ws.deserializeAttachment() || {};
    if (msg.type === 'join') return this.join(ws, msg);
    const player = att.playerId && this.room.players[att.playerId];
    if (!player) return this.safeSend(ws, { type: 'error', message: 'Join the room first.' });
    player.lastSeen = now();
    const r = this.room;

    switch (msg.type) {
      case 'leave':
        return this.leave(ws, player);

      case 'theme': {
        if (this.busy.has(ws)) return;
        if (r.phase !== 'theme' || !r.story) throw new GameError('Nobody is choosing a theme right now.');
        if (player.id !== r.story.setterId) throw new GameError('Only the theme setter can set the theme.');
        const theme = cleanText(msg.theme, LIMITS.theme);
        if (!theme) throw new GameError('Write a theme first.');
        this.busy.add(ws);
        let bad;
        try {
          bad = await this.flagged(theme);
        } finally {
          this.busy.delete(ws);
        }
        if (bad) throw new GameError('Pick a different theme.');
        // The room may have moved on while Jev was checking.
        if (r.phase !== 'theme' || !r.story || player.id !== r.story.setterId) throw new GameError('Nobody is choosing a theme right now.');
        r.story.theme = theme;
        r.story.length = normalizeLength(msg.length);
        if (msg.weights) r.story.weights = normalizeWeights(msg.weights);
        await this.beginRound(false);
        return;
      }

      case 'weights': {
        if (!r.story) return;
        if (player.id !== r.story.setterId) throw new GameError('Only the theme setter can tune Jev this round.');
        r.story.weights = normalizeWeights(msg.weights);
        await this.commit();
        return;
      }

      case 'sentence': {
        if (r.phase !== 'writing' || !r.round) throw new GameError('Writing is closed for this round.');
        const text = cleanText(msg.text, r.settings.maxSentenceChars);
        if (!text) {
          delete r.round.submissions[player.id];
        } else {
          r.round.submissions[player.id] = { text, at: now() };
        }
        const connected = this.connectedPlayers();
        if (connected.length >= 2 && connected.every((p) => r.round.submissions[p.id])) {
          await this.closeWriting();
        } else {
          await this.commit();
        }
        return;
      }

      case 'tap': {
        // A pick can be changed any time before the reveal ends; only the
        // final pick counts. Tapping the current pick again clears it, and
        // index null clears it explicitly.
        if (r.phase !== 'reveal' || !r.results || !r.results.top) throw new GameError('Nothing to pick right now.');
        if (msg.index === null || msg.index === undefined) {
          delete r.results.taps[player.id];
          await this.commit();
          return;
        }
        const idx = Number(msg.index);
        const line = r.results.top[idx];
        if (!line) throw new GameError('That line is not in the top five.');
        if (line.authorId === player.id) throw new GameError('You cannot pick your own line.');
        if (r.results.taps[player.id] === idx) delete r.results.taps[player.id];
        else r.results.taps[player.id] = idx;
        await this.commit();
        return;
      }

      case 'skip': {
        if (r.phase !== 'reveal') return;
        if (!r.story || player.id !== r.story.setterId) throw new GameError('Only the theme setter can skip ahead.');
        await this.finishReveal();
        return;
      }

      case 'end-story': {
        if (!r.story || player.id !== r.story.setterId) throw new GameError('Only the theme setter can end the story.');
        if (r.phase === 'reveal') {
          await this.finishReveal({ endNow: true });
        } else if (r.phase === 'writing') {
          // The tap raced the reveal timer into the next round: end it anyway,
          // leaving out the lines not yet judged.
          await this.endStory('setter');
        } else {
          throw new GameError('The story can be ended once a round has been revealed.');
        }
        return;
      }

      default:
        throw new GameError('Unknown message');
    }
  }

  // Jev checks a nickname or a theme against the room's filters. When Jev
  // cannot be reached the text goes through unchecked, so an outage never
  // locks anyone out of a room.
  async flagged(text) {
    try {
      const { flags } = await checkText(this.env, { text, filters: this.rating().filters });
      return flags.length > 0;
    } catch (err) {
      console.error('text check failed', err);
      return false;
    }
  }

  // The words a player sees for a filter that caught their line.
  filterLabel(key) {
    if (key === UNCHECKED) return UNCHECKED_LABEL;
    const f = this.rating().filters.find((x) => x.key === key);
    return f ? f.label : key;
  }

  async join(ws, msg) {
    const r = this.room;
    if (this.busy.has(ws)) return;
    const att = ws.deserializeAttachment() || {};
    const seated = att.playerId ? r.players[att.playerId] || null : null;
    let player = null;
    if (typeof msg.token === 'string' && msg.token) {
      player = Object.values(r.players).find((p) => p.token === msg.token) || null;
    }
    if (seated && player && player.id === seated.id) {
      // Already in this seat: just confirm it.
      this.safeSend(ws, { type: 'joined', playerId: player.id, token: player.token, nick: player.nick, code: r.code });
      this.broadcastSoon();
      return;
    }
    // A connection holds one seat. Joining again as someone else gives the
    // old seat up at once, so it never lingers as a phantom player.
    if (seated) {
      this.dropSeat(seated);
      await this.commit();
    }
    const requestedNick = cleanText(msg.nick, LIMITS.nick) || 'Anon';

    if (!player) {
      const full = () => Object.keys(r.players).length >= r.settings.maxPlayers;
      const refuse = (message) => this.safeSend(ws, { type: 'error', message, fatal: true });
      if (full()) return refuse('This room is full right now. Try another room.');
      this.busy.add(ws);
      let bad;
      try {
        bad = requestedNick !== 'Anon' && (await this.flagged(requestedNick));
      } finally {
        this.busy.delete(ws);
      }
      if (bad) return refuse('Pick a different nickname.');
      // The connection may have gone, or the room filled up, while Jev was checking.
      if (ws.readyState !== WebSocket.OPEN) return;
      if (full()) return refuse('This room is full right now. Try another room.');
      // Nobody else is connected: whatever story was left behind is abandoned
      // (for example one paused before this rule existed), so a newcomer starts
      // fresh instead of landing in the middle of it.
      if (this.connectedPlayers().length === 0 && (r.story || r.lastStory)) this.resetStory();
      player = {
        id: crypto.randomUUID(),
        token: crypto.randomUUID(),
        nick: this.uniqueNick(requestedNick),
        emoji: pickEmoji(msg.emoji, r.nextOrder),
        score: 0,
        wins: 0,
        order: r.nextOrder++,
        joinedAt: now(),
        connected: true,
        lastSeen: now(),
      };
      r.players[player.id] = player;
    } else {
      // Reconnect. Close any stale socket that still claims this seat.
      for (const other of this.ctx.getWebSockets()) {
        if (other === ws) continue;
        const a = other.deserializeAttachment() || {};
        if (a.playerId === player.id) {
          try {
            other.close(4000, 'Replaced by a new connection');
          } catch {
            /* ignore */
          }
        }
      }
      // A returning player keeps the icon they joined with: icons are chosen
      // before joining and cannot change once in a room.
      player.connected = true;
      player.lastSeen = now();
    }
    r.emptySince = null;
    this.rosterDirty = true;
    this.setAttachment(ws, { playerId: player.id });
    this.safeSend(ws, { type: 'joined', playerId: player.id, token: player.token, nick: player.nick, code: r.code });
    await this.afterPlayerChange();
  }

  async leave(ws, player) {
    this.dropSeat(player);
    try {
      this.setAttachment(ws, { playerId: null });
      this.safeSend(ws, { type: 'left' });
      ws.close(1000, 'left');
    } catch {
      /* ignore */
    }
    if (this.connectedPlayers().length === 0) this.room.emptySince = now();
    await this.afterPlayerChange();
  }

  // Removes a seat outright, with its line and pick for the current round:
  // a Leave, or a connection that took another seat.
  dropSeat(player) {
    const r = this.room;
    delete r.players[player.id];
    if (r.round) delete r.round.submissions[player.id];
    if (r.results && r.results.taps) delete r.results.taps[player.id];
    // The last person in the room has left: the next arrivals get a fresh story.
    if (this.connectedPlayers().length === 0) this.resetStory();
    this.rosterDirty = true;
  }

  uniqueNick(nick) {
    const taken = new Set(Object.values(this.room.players).map((p) => p.nick.toLowerCase()));
    if (!taken.has(nick.toLowerCase())) return nick;
    for (let i = 2; i < 1000; i++) {
      const candidate = `${nick.slice(0, LIMITS.nick - 4)} ${i}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return `${nick.slice(0, LIMITS.nick - 5)} ${Math.floor(Math.random() * 9999)}`;
  }

  // ------------------------------------------------------ Player changes

  connectedPlayers() {
    return Object.values(this.room.players)
      .filter((p) => p.connected)
      .sort((a, b) => a.order - b.order);
  }

  async afterPlayerChange() {
    const r = this.room;
    this.reconcilePresence();
    this.ensureSetter();
    // A paused room resumes first, so that a round everyone has already
    // written can close right away instead of staying paused.
    await this.checkPause();
    // Everyone remaining has already written: close the round early.
    if (r.phase === 'writing' && r.round) {
      const connected = this.connectedPlayers();
      if (connected.length >= 2 && connected.every((p) => r.round.submissions[p.id])) {
        await this.closeWriting();
        return;
      }
    }
    await this.commit();
  }

  // The setter role always belongs to a connected player. When the current
  // setter is gone, the next player in line takes over for the rest of the story.
  ensureSetter() {
    const r = this.room;
    if (!r.story) return;
    const s = r.players[r.story.setterId];
    if (s && s.connected) return;
    this.passSetter();
  }

  passSetter() {
    const r = this.room;
    if (!r.story) return false;
    const others = this.connectedPlayers().filter((p) => p.id !== r.story.setterId);
    const next = nextSetter(others, r.story.setterOrder || 0);
    if (!next) return false;
    r.story.setterId = next.id;
    r.story.setterNick = next.nick;
    r.story.setterEmoji = next.emoji;
    r.story.setterOrder = next.order;
    r.lastSetterOrder = next.order;
    if (r.phase === 'theme') r.deadline = now() + r.settings.themeSeconds * 1000;
    return true;
  }

  // Below two connected players the clock stops; it resumes when someone
  // joins. The first resume of a phase tops its clock up to MIN_RESUME_MS so
  // the returning player gets a moment; later resumes of the same phase get
  // only what was left, so a connection that keeps dropping and returning
  // cannot stretch a phase forever.
  async checkPause() {
    const r = this.room;
    const count = this.connectedPlayers().length;
    if (r.phase !== 'paused' && ACTIVE_PHASES.has(r.phase) && count < 2) {
      r.paused = { phase: r.phase, remainingMs: r.deadline ? Math.max(0, r.deadline - now()) : 0, key: this.phaseKey() };
      r.phase = 'paused';
      r.deadline = null;
    } else if (r.phase === 'paused' && count >= 2) {
      const { phase, remainingMs, key } = r.paused || { phase: 'theme', remainingMs: 0 };
      r.paused = null;
      if (phase === 'theme' && (!r.story || !r.players[r.story.setterId]?.connected)) {
        await this.beginStory(false);
        return;
      }
      const first = !key || r.resumedKey !== key;
      if (key) r.resumedKey = key;
      r.phase = phase;
      r.deadline = now() + (first ? Math.max(remainingMs, MIN_RESUME_MS) : remainingMs);
    }
  }

  // Names the phase instance being paused, so a later resume of the same
  // phase is recognised as such.
  phaseKey() {
    const r = this.room;
    return [r.phase, r.story?.index, r.round?.index, r.round?.attempts, r.results?.judgedAt, r.lastStory?.endedAt].join('|');
  }

  // Everyone has gone: drop the abandoned story so the next players choose a
  // new theme. Story numbering starts over; the room keeps what it has
  // learned from players' picks.
  resetStory() {
    const r = this.room;
    r.story = null;
    r.round = null;
    r.results = null;
    r.lastStory = null;
    r.storyCount = 0;
    r.phase = 'paused';
    r.paused = { phase: 'theme', remainingMs: 0 };
    r.deadline = null;
  }

  // --------------------------------------------------------- Game phases

  async beginStory(commit = true) {
    const r = this.room;
    const connected = this.connectedPlayers();
    const setter = nextSetter(connected, r.lastSetterOrder);
    if (!setter || connected.length < 2) {
      r.story = null;
      r.round = null;
      r.results = null;
      r.phase = 'paused';
      r.paused = { phase: 'theme', remainingMs: 0 };
      r.deadline = null;
      if (commit) await this.commit();
      return;
    }
    r.lastSetterOrder = setter.order;
    // A story whose theme was never set keeps its number.
    const reuseNumber = r.story && !r.story.theme && r.story.sentences.length === 0;
    if (!reuseNumber) r.storyCount += 1;
    r.story = {
      index: r.storyCount,
      theme: null,
      length: 'medium',
      setterId: setter.id,
      setterNick: setter.nick,
      setterEmoji: setter.emoji,
      setterOrder: setter.order,
      sentences: [],
      weights: normalizeWeights(r.learned),
      startedAt: now(),
    };
    r.round = null;
    r.results = null;
    r.phase = 'theme';
    r.deadline = now() + r.settings.themeSeconds * 1000;
    if (commit) await this.commit();
  }

  async beginRound(replay = false) {
    const r = this.room;
    const prev = r.round;
    r.round = {
      index: r.story.sentences.length + 1,
      attempts: replay && prev ? prev.attempts + 1 : 0,
      submissions: replay && prev ? prev.submissions : {},
      openedAt: now(),
    };
    r.phase = 'writing';
    r.deadline = now() + r.settings.writingSeconds * 1000;
    await this.checkPause();
    await this.commit();
  }

  // The lines written this round by players who are still in the room.
  roundCandidates() {
    const r = this.room;
    if (!r.round) return [];
    return Object.entries(r.round.submissions)
      .filter(([pid, s]) => r.players[pid] && s.text)
      .map(([pid, s]) => ({ playerId: pid, text: s.text }));
  }

  async closeWriting() {
    const r = this.room;
    if (r.phase !== 'writing' || this.judging) return;
    const candidates = this.roundCandidates();

    if (candidates.length === 0) {
      if (r.round.attempts < 1) {
        r.results = {
          roundIndex: r.round.index,
          top: [],
          others: [],
          filtered: [],
          taps: {},
          winnerId: null,
          error: 'Nobody wrote a sentence. One more try!',
          ends: false,
          judgedAt: now(),
        };
        r.round.attempts += 1;
        r.phase = 'reveal';
        r.deadline = now() + Math.min(r.settings.revealSeconds, 8) * 1000;
        await this.commit();
      } else {
        await this.endStory('abandoned');
      }
      return;
    }

    r.phase = 'judging';
    r.deadline = null;
    r.judgingSince = now();
    await this.commit();
    await this.judge(candidates);
  }

  // Jev never answered, usually because of a restart mid-judge: the round is
  // judged again from the lines it still has.
  async rejudge() {
    const r = this.room;
    const candidates = this.roundCandidates();
    if (!candidates.length) {
      // Everyone who wrote has gone: close the round as one with no lines.
      r.phase = 'writing';
      await this.closeWriting();
      return;
    }
    r.judgingSince = now();
    await this.commit();
    await this.judge(candidates);
  }

  async judge(candidates) {
    const r = this.room;
    this.judging = true;
    const t0 = now();
    // Shuffle so position never favors anyone, then label A, B, C...
    const shuffled = [...candidates];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    shuffled.forEach((c, i) => (c.id = candidateId(i)));
    const byId = new Map(shuffled.map((c) => [c.id, c]));

    const weightsUsed = { ...r.story.weights };
    let outcome;
    try {
      const verdict = await judgeRound(this.env, {
        theme: r.story.theme,
        sentences: r.story.sentences.map((s) => s.text),
        candidates: shuffled.map((c) => ({ id: c.id, text: c.text })),
        weights: weightsUsed,
        length: r.story.length,
        filters: this.rating().filters,
      });
      const rows = verdict.ranked.map((row) => {
        const c = byId.get(row.id);
        const p = r.players[c.playerId];
        return {
          text: c.text,
          authorId: c.playerId,
          authorNick: p ? p.nick : 'Someone who left',
          authorEmoji: p ? p.emoji : '',
          share: row.share,
          dims: row.dims,
          closure: row.closure,
          flags: row.flags,
          filtered: row.filtered,
        };
      });
      const eligible = rows.filter((x) => !x.filtered);
      const top = eligible.slice(0, TOP_N).map((x, i) => ({ index: i, ...x }));
      const others = eligible
        .slice(TOP_N, TOP_N + OTHERS_N)
        .map((x) => ({ text: x.text, authorNick: x.authorNick, authorEmoji: x.authorEmoji, share: x.share }));
      const othersTotal = Math.max(0, eligible.length - TOP_N);
      const filtered = rows.filter((x) => x.filtered).map((x) => ({ authorId: x.authorId, text: x.text, flags: x.flags.map((k) => this.filterLabel(k)) }));
      const winner = top[0] || null;
      outcome = {
        roundIndex: r.round.index,
        candidates: candidates.length,
        top,
        others,
        othersTotal,
        filtered,
        taps: {},
        winnerId: winner ? winner.authorId : null,
        winnerText: winner ? winner.text : null,
        ends: verdict.ends,
        endReason: verdict.endReason,
        weights: weightsUsed,
        closureWeight: verdict.closureWeight,
        model: verdict.model,
        requests: verdict.requests,
        ms: now() - t0,
        error: winner ? null : 'Jev filtered every line this round. Try again!',
        judgedAt: now(),
      };
    } catch (err) {
      console.error('judge failed', err);
      outcome = {
        roundIndex: r.round.index,
        candidates: candidates.length,
        top: [],
        others: [],
        filtered: [],
        taps: {},
        winnerId: null,
        ends: false,
        ms: now() - t0,
        error: JUDGE_ERROR,
        judgedAt: now(),
      };
    } finally {
      this.judging = false;
    }

    // The room may have changed while Jev was thinking.
    if (!this.room || r.phase !== 'judging') return;

    r.results = outcome;
    if (outcome.winnerId) {
      const author = r.players[outcome.winnerId];
      r.story.sentences.push({
        text: outcome.winnerText,
        authorId: outcome.winnerId,
        authorNick: author ? author.nick : 'Someone who left',
        authorEmoji: author ? author.emoji : '',
        share: outcome.top[0].share,
        round: r.round.index,
      });
      if (author) {
        author.score += 1;
        author.wins += 1;
        this.rosterDirty = true;
      }
    }
    r.phase = 'reveal';
    r.deadline = now() + r.settings.revealSeconds * 1000;
    await this.checkPause();
    await this.commit();
  }

  // Ends the reveal (timer, setter skip, or the setter ending the story):
  // taps become feedback, then the game moves on.
  async finishReveal({ endNow = false } = {}) {
    const r = this.room;
    if (r.phase !== 'reveal') return;
    const res = r.results;
    if (res && res.top && res.top.length) {
      const learn = learnFromTaps(r.learned, res.top, res.taps);
      r.learned = learn.weights;
      r.feedback.rounds += 1;
      r.feedback.taps += learn.taps;
      r.feedback.agreements += learn.agreements;
    }
    if (endNow) {
      // If Jev had already decided this line ends the story, keep Jev's reason.
      await this.endStory(res && res.ends ? res.endReason || 'jev' : 'setter');
      return;
    }
    await this.afterReveal();
  }

  async afterReveal() {
    const r = this.room;
    const res = r.results;
    if (res && res.winnerId) {
      if (res.ends) await this.endStory(res.endReason || 'jev');
      else await this.beginRound(false);
    } else if (res && !res.winnerId && r.round && r.round.attempts >= 2) {
      // Two failed attempts on the same round: close the story rather than loop.
      await this.endStory(r.story.sentences.length ? 'jev' : 'abandoned');
    } else {
      await this.beginRound(true);
    }
  }

  async endStory(reason) {
    const r = this.room;
    const setterNick = r.story ? r.players[r.story.setterId]?.nick || r.story.setterNick : '';
    const endText = reason === 'setter' ? `${setterNick} ended the story.` : END_REASON_TEXT[reason] || 'The story ended.';
    r.lastStory = r.story ? { ...r.story, endedAt: now(), endReason: reason, endText } : null;
    r.story = null;
    r.round = null;
    r.results = null;
    if (!r.lastStory || r.lastStory.sentences.length === 0) {
      // Nothing to show: move straight on to the next theme setter.
      r.lastStory = null;
      await this.beginStory();
      return;
    }
    r.phase = 'storyEnd';
    r.deadline = now() + r.settings.storyEndSeconds * 1000;
    r.lastStory.jevScore = { pending: true };
    await this.checkPause();
    await this.commit();
    await this.scoreLastStory();
  }

  // Jev rates the finished story while the end screen is up. The score is
  // attached only if that same story is still the one on screen.
  async scoreLastStory() {
    const story = this.room && this.room.lastStory;
    if (!story) return;
    const endedAt = story.endedAt;
    let jevScore;
    try {
      const s = await scoreStory(this.env, { theme: story.theme, sentences: story.sentences.map((x) => x.text), weights: story.weights });
      jevScore = { ...s, scoredAt: now() };
    } catch (err) {
      console.error('story score failed', err);
      jevScore = { error: STORY_SCORE_ERROR };
    }
    const r = this.room;
    if (!r || !r.lastStory || r.lastStory.endedAt !== endedAt) return;
    r.lastStory.jevScore = jevScore;
    await this.commit();
  }

  // ------------------------------------------------------------- Timers

  async alarm() {
    if (!this.room) return;
    const r = this.room;
    const t = now();

    // Presence follows live connections; then every grace period that has
    // run out frees its seat and score.
    let changed = this.reconcilePresence();
    for (const p of Object.values(r.players)) {
      if (!p.connected && t - p.lastSeen >= GRACE_MS) {
        delete r.players[p.id];
        if (r.round) delete r.round.submissions[p.id];
        changed = true;
        this.rosterDirty = true;
      }
    }

    // Empty for an hour: clear the table but keep what the room has learned.
    if (r.emptySince && Object.values(r.players).every((p) => !p.connected) && t - r.emptySince >= EMPTY_ROOM_SLEEP_MS) {
      Object.assign(r, {
        players: {},
        story: null,
        round: null,
        results: null,
        lastStory: null,
        phase: 'paused',
        paused: { phase: 'theme', remainingMs: 0 },
        deadline: null,
        emptySince: null,
      });
      await this.save();
      await this.ctx.storage.deleteAlarm();
      return;
    }

    // Jev never answered (a restart mid-judge): judge the round again.
    if (r.phase === 'judging' && !this.judging && t >= (r.judgingSince || 0) + JUDGE_WATCHDOG_MS - 25) {
      await this.rejudge();
      return;
    }

    if (r.deadline && t >= r.deadline - 25 && !this.judging) {
      switch (r.phase) {
        case 'theme': {
          // Out of time: the theme passes to the next player in line.
          if (!this.passSetter()) await this.checkPause();
          await this.commit();
          return;
        }
        case 'writing':
          await this.closeWriting();
          return;
        case 'reveal':
          await this.finishReveal();
          return;
        case 'storyEnd':
          await this.beginStory();
          return;
        default:
          r.deadline = null;
      }
    }

    if (changed) await this.afterPlayerChange();
    else await this.commit();
  }

  // The single alarm serves phase deadlines, grace expiries and room cleanup.
  async scheduleAlarm() {
    const r = this.room;
    if (!r) return;
    const times = [];
    if (r.deadline) times.push(r.deadline);
    if (r.phase === 'judging') times.push((r.judgingSince || 0) + JUDGE_WATCHDOG_MS);
    for (const p of Object.values(r.players)) {
      if (!p.connected) times.push(p.lastSeen + GRACE_MS);
    }
    if (r.emptySince) times.push(r.emptySince + EMPTY_ROOM_SLEEP_MS);
    if (!times.length) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const next = Math.max(now() + 50, Math.min(...times));
    await this.ctx.storage.setAlarm(next);
  }

  // ----------------------------------------------------------- Plumbing

  async save() {
    if (this.room) await this.ctx.storage.put('room', this.room);
  }

  async commit() {
    await this.save();
    await this.scheduleAlarm();
    this.broadcastSoon();
  }

  safeSend(ws, obj) {
    try {
      ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
    } catch {
      /* socket gone */
    }
  }

  // With many players every submission would otherwise fan out immediately;
  // updates within a short window are merged into one broadcast.
  broadcastSoon() {
    const since = now() - this.lastBroadcastAt;
    if (since >= BROADCAST_COALESCE_MS && !this.broadcastTimer) {
      this.broadcast();
      return;
    }
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      this.broadcast();
    }, Math.max(10, BROADCAST_COALESCE_MS - since));
  }

  broadcast() {
    if (!this.room) return;
    this.lastBroadcastAt = now();
    const base = this.baseSnapshot();
    if (!this.rosterDirty) delete base.players;
    this.rosterDirty = false;
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() || {};
      if (!att.playerId || !this.room.players[att.playerId]) continue;
      this.safeSend(ws, this.personalize(base, att.playerId));
    }
  }

  baseSnapshot() {
    const r = this.room;
    const rating = this.rating();
    const players = Object.values(r.players)
      .sort((a, b) => a.order - b.order)
      .map((p) => ({ id: p.id, nick: p.nick, emoji: p.emoji, score: p.score, wins: p.wins, connected: p.connected, joinedAt: p.joinedAt }));
    const story = r.story
      ? {
          index: r.story.index,
          theme: r.story.theme,
          length: r.story.length,
          setterId: r.story.setterId,
          setterNick: r.players[r.story.setterId]?.nick || r.story.setterNick,
          setterEmoji: r.players[r.story.setterId]?.emoji || r.story.setterEmoji || '',
          sentences: r.story.sentences,
          weights: r.story.weights,
        }
      : null;
    const round = r.round
      ? {
          index: r.round.index,
          attempts: r.round.attempts,
          submittedCount: Object.keys(r.round.submissions).filter((id) => r.players[id]).length,
        }
      : null;
    let results = null;
    if (r.results) {
      const tapCounts = new Array((r.results.top || []).length).fill(0);
      for (const idx of Object.values(r.results.taps || {})) if (tapCounts[idx] !== undefined) tapCounts[idx] += 1;
      // Filtered lines travel per player (see personalize); here only their count.
      const { taps, filtered, ...rest } = r.results;
      results = { ...rest, tapCounts, filteredCount: (filtered || []).length };
    }
    return {
      type: 'state',
      v: PROTOCOL_VERSION,
      now: now(),
      code: r.code,
      room: { code: rating.code, label: rating.label, slug: rating.slug, filters: rating.filters.map((f) => f.label) },
      phase: r.phase,
      deadline: r.deadline,
      paused: r.paused ? { phase: r.paused.phase } : null,
      players,
      settings: r.settings,
      story,
      round,
      results,
      lastStory: r.phase === 'storyEnd' ? r.lastStory : null,
      storyCount: r.storyCount,
      nextSetterNick: r.phase === 'storyEnd' ? nextSetter(this.connectedPlayers(), r.lastSetterOrder)?.nick || null : null,
      nextSetterEmoji: r.phase === 'storyEnd' ? nextSetter(this.connectedPlayers(), r.lastSetterOrder)?.emoji || '' : '',
      learned: r.learned,
      feedback: r.feedback,
    };
  }

  // Per-player fields: own draft, own tap, and own filtered line with the
  // reasons. Nobody learns whose other lines were filtered, or why.
  personalize(base, playerId) {
    const r = this.room;
    const out = { ...base, youId: playerId };
    if (base.round) out.round = { ...base.round, mine: r.round?.submissions[playerId]?.text || '' };
    if (base.results) {
      const myTap = r.results && r.results.taps ? r.results.taps[playerId] : undefined;
      const mine = (r.results && r.results.filtered ? r.results.filtered : []).filter((f) => f.authorId === playerId);
      out.results = {
        ...base.results,
        myTap: myTap === undefined ? null : myTap,
        filtered: mine.map((f) => ({ text: f.text, flags: f.flags })),
      };
    }
    return JSON.stringify(out);
  }
}
