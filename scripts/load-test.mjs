// Synthetic players for load testing a room. Each bot joins over WebSocket,
// sets a theme when it is the setter, writes a line every round, taps a
// favorite in the reveal, and reports Jev's judging time per round.
//
//   node scripts/load-test.mjs --url=ws://localhost:8787 --room=T --players=100 --stories=2
//
// Needs Node 22+ (global WebSocket). Bots leave the room when done.

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  }),
);
const URL_BASE = String(args.url || 'ws://localhost:8787').replace(/\/$/, '');
const ROOM = String(args.room || 'T').toUpperCase();
const PLAYERS = Number(args.players || 20);
const STORIES = Number(args.stories || 1);
const TIMEOUT_MS = Number(args.timeout || 8 * 60_000);
const VERBOSE = Boolean(args.verbose);
// --clear-taps: every bot that picks a line clears its pick a few seconds
// later, so the tap traffic is real but no final pick is left behind. Use it
// against a production room so its learned taste is not skewed by bots.
const CLEAR_TAPS = Boolean(args['clear-taps']);

const THEMES = ['A moose runs the last video store', 'Grandma joins a biker gang', 'The haunted vending machine', 'A pirate afraid of water'];
const OPENERS = ['Nobody expected', 'Against all advice', 'On a Tuesday', 'For the third time that week', 'Somewhere near the freezer aisle'];
const SUBJECTS = ['the moose', 'Grandma', 'the vending machine', 'Captain Dry', 'a very small accountant', 'the mayor'];
const VERBS = ['declared war on', 'apologized to', 'married', 'tried to return', 'accidentally ate', 'started a podcast with'];
const OBJECTS = ['a bag of frozen peas', 'the entire town council', 'a suspiciously polite raccoon', 'its own reflection', 'the last VHS on Earth', 'a tax form'];
const TAILS = ['and everyone applauded.', 'which fixed nothing.', 'and the lights went out.', 'to thunderous silence.', 'and that was only the beginning.', 'The end.'];

function line(i, round) {
  const pick = (arr, n) => arr[(i * 7 + round * 3 + n) % arr.length];
  const spicy = i % 10 === 3 ? 'fucking ' : '';
  return `${pick(OPENERS, 0)}, ${pick(SUBJECTS, 1)} ${pick(VERBS, 2)} ${spicy}${pick(OBJECTS, 3)}, ${pick(TAILS, 4)}`;
}

const startedAt = Date.now();
const stats = {
  joined: 0,
  errors: [],
  rounds: new Map(), // key -> { judgingAt, revealAt, candidates, requests, ms, filtered }
  stories: 0,
  states: 0,
  bytes: 0,
};

class Bot {
  constructor(i) {
    this.i = i;
    this.nick = `Bot${String(i + 1).padStart(3, '0')}`;
    this.id = null;
    this.done = new Set();
    this.ws = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${URL_BASE}/ws/${ROOM}`);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error(`${this.nick}: join timeout`)), 20000);
      ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'join', nick: this.nick })));
      ws.addEventListener('message', (ev) => {
        if (typeof ev.data !== 'string' || ev.data[0] !== '{') return;
        stats.states += 1;
        stats.bytes += ev.data.length;
        const msg = JSON.parse(ev.data);
        if (msg.type === 'joined') {
          this.id = msg.playerId;
          stats.joined += 1;
          clearTimeout(timer);
          resolve();
        } else if (msg.type === 'error') {
          stats.errors.push(`${this.nick}: ${msg.message}`);
          if (msg.fatal) {
            clearTimeout(timer);
            reject(new Error(msg.message));
          }
        } else if (msg.type === 'state') {
          try {
            this.onState(msg);
          } catch (err) {
            stats.errors.push(`${this.nick}: ${err.message}`);
          }
        }
      });
      ws.addEventListener('error', () => {});
      ws.addEventListener('close', () => {});
    });
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  onState(s) {
    const storyIdx = s.story ? s.story.index : 0;
    if (s.phase === 'theme' && s.story && s.story.setterId === this.id) {
      const key = `theme:${storyIdx}`;
      if (!this.done.has(key)) {
        this.done.add(key);
        setTimeout(() => this.send({ type: 'theme', theme: THEMES[storyIdx % THEMES.length], length: 'short' }), 300);
      }
    }
    if (s.phase === 'writing' && s.round) {
      const key = `write:${storyIdx}:${s.round.index}:${s.round.attempts}`;
      if (!this.done.has(key)) {
        this.done.add(key);
        const delay = 200 + Math.random() * 2500;
        setTimeout(() => this.send({ type: 'sentence', text: line(this.i, s.round.index) }), delay);
      }
    }
    if (s.phase === 'judging' && s.round && this.i === 0) {
      const key = `${storyIdx}:${s.round.index}:${s.round.attempts}`;
      if (!stats.rounds.has(key)) stats.rounds.set(key, { judgingAt: Date.now() });
    }
    if (s.phase === 'reveal' && s.results) {
      const key = `${storyIdx}:${s.results.roundIndex}:${s.round ? s.round.attempts : 0}`;
      if (this.i === 0) {
        const rec = stats.rounds.get(key) || { judgingAt: null };
        if (!rec.revealAt) {
          rec.revealAt = Date.now();
          rec.candidates = s.results.candidates;
          rec.requests = s.results.requests;
          rec.ms = s.results.ms;
          rec.filtered = (s.results.filtered || []).length;
          rec.top = (s.results.top || []).length;
          rec.error = s.results.error || null;
          stats.rounds.set(key, rec);
          if (VERBOSE) console.log(`round ${key}: ${rec.candidates} lines, ${rec.requests} requests, server ${rec.ms} ms, filtered ${rec.filtered}${rec.error ? `, error: ${rec.error}` : ''}`);
        }
      }
      const tapKey = `tap:${key}`;
      if (!this.done.has(tapKey) && s.results.top && s.results.top.length > 1) {
        this.done.add(tapKey);
        const choices = s.results.top.filter((t) => t.authorId !== this.id);
        if (choices.length && Math.random() < 0.7) {
          const pick = choices[Math.floor(Math.random() * choices.length)];
          setTimeout(() => this.send({ type: 'tap', index: pick.index }), 200 + Math.random() * 1500);
          if (CLEAR_TAPS) setTimeout(() => this.send({ type: 'tap', index: null }), 3000 + Math.random() * 4000);
        }
      }
    }
    // A room resumes into the end screen of a story that finished before we
    // joined; only count stories that ended after this run started.
    if (s.phase === 'storyEnd' && s.lastStory && this.i === 0 && s.lastStory.endedAt >= startedAt) {
      const key = `story:${s.lastStory.index}`;
      if (!this.done.has(key)) {
        this.done.add(key);
        stats.stories += 1;
        if (VERBOSE) console.log(`story #${s.lastStory.index} ended: ${s.lastStory.sentences.length} lines (${s.lastStory.endReason})`);
      }
    }
  }

  leave() {
    this.send({ type: 'leave' });
    setTimeout(() => {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
    }, 200);
  }
}

async function main() {
  console.log(
    `Joining ${PLAYERS} bots to room ${ROOM} at ${URL_BASE} for ${STORIES} ${STORIES === 1 ? 'story' : 'stories'}${CLEAR_TAPS ? ' (picks are cleared, learned taste untouched)' : ''}…`,
  );
  const bots = Array.from({ length: PLAYERS }, (_, i) => new Bot(i));
  const t0 = Date.now();
  // Stagger connections a little so the room is not hit by 100 joins in one tick.
  for (let i = 0; i < bots.length; i += 10) {
    await Promise.all(bots.slice(i, i + 10).map((b) => b.connect().catch((err) => stats.errors.push(err.message))));
  }
  console.log(`${stats.joined} joined in ${Date.now() - t0} ms`);

  const started = Date.now();
  while (stats.stories < STORIES && Date.now() - started < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, 1000));
  }

  const rounds = [...stats.rounds.values()].filter((r) => r.revealAt);
  const latencies = rounds.filter((r) => r.judgingAt).map((r) => r.revealAt - r.judgingAt);
  const avg = (a) => (a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : 0);
  console.log('');
  console.log(`Result: ${stats.stories} ${stats.stories === 1 ? 'story' : 'stories'}, ${rounds.length} judged rounds, ${stats.states} state messages (${Math.round(stats.bytes / 1024)} KB) received by ${stats.joined} bots`);
  if (rounds.length) {
    console.log(`Lines per round: min ${Math.min(...rounds.map((r) => r.candidates))}, max ${Math.max(...rounds.map((r) => r.candidates))}`);
    console.log(`TypeSafe requests per round: ${[...new Set(rounds.map((r) => r.requests))].join(', ')}`);
    console.log(`Server judging time: min ${Math.min(...rounds.map((r) => r.ms))} ms, avg ${avg(rounds.map((r) => r.ms))} ms, max ${Math.max(...rounds.map((r) => r.ms))} ms`);
    if (latencies.length) console.log(`Judging to reveal as seen by a client: avg ${avg(latencies)} ms, max ${Math.max(...latencies)} ms`);
    console.log(`Filtered lines per round: ${rounds.map((r) => r.filtered).join(', ')}`);
    const errs = rounds.filter((r) => r.error);
    if (errs.length) console.log(`Rounds with errors: ${errs.map((r) => r.error).join(' | ')}`);
  }
  if (stats.errors.length) console.log(`Bot errors (${stats.errors.length}): ${[...new Set(stats.errors)].slice(0, 5).join(' | ')}`);
  if (stats.stories < STORIES) console.log('Timed out before the requested number of stories finished.');

  for (const b of bots) b.leave();
  await new Promise((r) => setTimeout(r, 800));
  process.exit(stats.stories >= STORIES && !rounds.some((r) => r.error) ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
