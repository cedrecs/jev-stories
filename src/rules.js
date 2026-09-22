// Shared game rules and constants (server side). The client keeps its own
// display copies of the labels; the numbers here are authoritative.

// Bump when the snapshot or message protocol changes: clients that see a
// different version in a snapshot reload themselves to pick up new code.
export const PROTOCOL_VERSION = 7;

// Player icons. Stored as code points so the source stays plain ASCII; the
// client carries the same list. A player may pick any of them, repeats allowed.
const EMOJI_CODES = [
  0x1f98a, 0x1f438, 0x1f419, 0x1f989, 0x1f422, 0x1f984, 0x1f41d, 0x1f427,
  0x1f996, 0x1f433, 0x1f98b, 0x1f43c, 0x1f42f, 0x1f981, 0x1f428, 0x1f430,
  0x1f43b, 0x1f435, 0x1f99c, 0x1f9a9, 0x1f40c, 0x1f344, 0x1f335, 0x1f680,
  0x1f431, 0x1f436, 0x1f980, 0x1f986, 0x1f994, 0x1f47b, 0x1f916, 0x1f47d,
];
export const EMOJIS = EMOJI_CODES.map((c) => String.fromCodePoint(c));

// An emoji from the list, or (when a fallback index is given) a default one.
export function pickEmoji(input, fallbackIndex = null) {
  if (typeof input === 'string' && EMOJIS.includes(input)) return input;
  if (fallbackIndex === null || fallbackIndex === undefined) return null;
  return EMOJIS[Math.abs(Math.floor(Number(fallbackIndex) || 0)) % EMOJIS.length];
}

export const LENGTHS = {
  short: { label: 'Short', min: 4, max: 7 },
  medium: { label: 'Medium', min: 7, max: 12 },
  long: { label: 'Long', min: 12, max: 18 },
};

// A story length key from the client, or medium. Only the keys above count:
// a name such as "__proto__" or "constructor" would otherwise look up an
// inherited property and make a story that never ends.
export function normalizeLength(input) {
  return typeof input === 'string' && Object.hasOwn(LENGTHS, input) ? input : 'medium';
}

// Each dimension becomes one Choice question over all candidate sentences.
// Jev returns a probability per candidate; code mixes them with the weights.
// When a story ends, the same four dimensions are asked again as Score
// questions over the whole story (storyInstructions and storyLevels, lowest
// level first; the text before the colon is the label players see).
export const DIMENSIONS = [
  {
    key: 'funny',
    label: 'Funny',
    default: 50,
    instructions:
      'Which candidate is the funniest next sentence for this story? Judge comedic effect for a group of friends playing a party game: wit, absurdity that lands, comic timing, and payoff of setups already present in the story so far. Ignore spelling and grammar unless they ruin the joke.',
    storyInstructions:
      'How funny is this finished story as a whole, for a group of friends playing a party game? Judge wit, absurdity that lands, comic timing and payoffs. Ignore spelling and grammar unless they ruin the joke.',
    storyLevels: [
      'Not funny: no joke lands; the story reads flat or confusing',
      'Slightly funny: one or two mildly amusing moments',
      'Funny: several lines land and it raises a smile throughout',
      'Very funny: most lines land and the jokes build on each other',
      'Hilarious: laugh-out-loud from start to finish with a great payoff',
    ],
  },
  {
    key: 'continuity',
    label: 'Flows from the story',
    default: 20,
    instructions:
      'Which candidate best continues the story so far? It should follow naturally from the previous sentence, keep characters, places and facts consistent, and move the story forward rather than restarting it. If the story has no sentences yet, prefer the strongest opening line for the theme.',
    storyInstructions:
      'How well does this finished story hold together from its first line to its last? Judge whether each sentence follows from the one before, whether characters, places and facts stay consistent, and whether it builds to an ending.',
    storyLevels: [
      'Incoherent: lines contradict each other or ignore what came before',
      'Choppy: some lines follow on, others jump around or restart',
      'Mostly coherent: it follows one thread with a few jumps',
      'Coherent: each line builds on the last and the ending fits',
      'Seamless: it reads like one author wrote it, with a satisfying arc',
    ],
  },
  {
    key: 'theme',
    label: 'Fits the theme',
    default: 15,
    instructions:
      'Which candidate fits the theme of the story best? Prefer sentences that clearly belong to the theme in setting, subject matter or tone, rather than generic sentences that could belong to any story.',
    storyInstructions: 'How well does this finished story fit its theme, in setting, subject matter and tone?',
    storyLevels: [
      'Off theme: the story ignores the theme',
      'Loosely related: the theme appears only briefly',
      'Partly on theme: the theme runs through parts of the story',
      'On theme: the theme is clear throughout',
      'Built on the theme: the theme drives the whole story and its punchline',
    ],
  },
  {
    key: 'surprise',
    label: 'Surprising',
    default: 15,
    instructions:
      'Which candidate is the most surprising, absurd or unexpected while still making sense as a sentence in this story? Prefer twists, escalation and wild imagery over predictable continuations.',
    storyInstructions:
      'How surprising and inventive is this finished story, while still making sense? Judge twists, escalation and wild imagery against predictable turns.',
    storyLevels: [
      'Predictable: nothing unexpected happens',
      'A little surprising: one small twist or odd detail',
      'Surprising: several unexpected turns',
      'Very surprising: inventive turns throughout',
      'Wildly inventive: twist after twist that still makes sense',
    ],
  },
];

// ---------------------------------------------------------------------------
// Rooms. Four fixed rooms, each with a preset list of content filters. Every
// filter becomes one yes/no (Noul) question per candidate sentence; a line
// answering yes to any filter of its room cannot win. Hate and harassment
// are filtered in every room except Absolute Degenerates, which has no
// filters at all.
//
// Naming: players see the label and the link slug. The one-letter code is
// only an internal key; it names the room's saved state (players, story,
// learned slider defaults), so it must never change.

const HATE = {
  key: 'hateful',
  label: 'hate and harassment',
  question: 'Is this sentence hateful or harassing?',
  criteria: {
    true: 'Slurs; demeaning people for race, religion, gender, sexuality, disability or nationality; threats; or attacks on a real person',
    false: 'At most rude to fictional characters; no group or real person is demeaned',
  },
};

export const RATINGS = {
  E: {
    code: 'E',
    label: 'Safe for Everyone',
    slug: 'safe-for-everyone',
    aliases: ['everyone'],
    tagline: 'Clean fun for all ages',
    filters: [
      {
        key: 'violence',
        label: 'violence',
        question: 'Does this sentence describe violence or injury beyond harmless slapstick?',
        criteria: {
          true: 'Fighting, weapons used on someone, blood, injury, death or cruelty',
          false: 'No violence, or only cartoon slapstick such as a pie in the face or a pratfall',
        },
      },
      {
        key: 'sexual',
        label: 'sexual content',
        question: 'Does this sentence contain sexual content or innuendo?',
        criteria: {
          true: 'Any sexual reference, innuendo, nudity or suggestive description',
          false: 'Nothing sexual; romance limited to affection such as holding hands or a kiss on the cheek',
        },
      },
      {
        key: 'profanity',
        label: 'swearing',
        question: 'Does this sentence contain any swearing or crude language?',
        criteria: {
          true: 'Any swear word, including mild ones such as damn, hell or crap, and crude words for body functions',
          false: 'No swearing or crude language at all',
        },
      },
      HATE,
    ],
  },
  T: {
    code: 'T',
    label: 'Moderated for Teens',
    slug: 'moderated-for-teens',
    aliases: ['teen', 'teens'],
    tagline: 'Mild language and cartoon mayhem are fine',
    filters: [
      {
        key: 'violence',
        label: 'graphic violence',
        question: 'Does this sentence contain graphic or gratuitous violence?',
        criteria: {
          true: 'Gore, torture, cruelty, or realistic injury or killing described for effect',
          false: 'No violence, or non-graphic action such as a chase, a punch or a cartoon explosion',
        },
      },
      {
        key: 'sexual',
        label: 'explicit sexual content',
        question: 'Does this sentence contain explicit sexual content?',
        criteria: {
          true: 'Sex acts, genitals or explicit sexual description',
          false: 'No sexual content, or only mild innuendo, romance or kissing',
        },
      },
      {
        key: 'profanity',
        label: 'strong profanity',
        question: 'Does this sentence contain strong profanity?',
        criteria: {
          true: 'Strong swear words such as the f-word, the s-word or vulgar terms for body parts, including masked or misspelled versions',
          false: 'No swearing, or only mild words such as damn, hell or crap',
        },
      },
      HATE,
    ],
  },
  M: {
    code: 'M',
    label: 'Mature Audience Only',
    slug: 'mature-audience-only',
    aliases: ['mature'],
    tagline: 'Strong language and adult humor allowed',
    filters: [
      {
        key: 'sexual',
        label: 'pornographic description',
        question: 'Does this sentence contain pornographic sexual description?',
        criteria: {
          true: 'Graphic, detailed description of sex acts or genitals',
          false: 'No sexual content, or sexual content that is referenced, joked about or implied without graphic detail',
        },
      },
      HATE,
    ],
  },
  A: {
    code: 'A',
    label: 'Absolute Degenerates',
    slug: 'absolute-degenerates',
    aliases: ['adult', 'degenerates'],
    tagline: 'Anything goes',
    filters: [],
  },
  // The Discord version has no rooms to choose from: the call is the room, and
  // each call gets one game with this rating. Its filters are set below. It
  // never appears on the website.
  D: {
    code: 'D',
    label: 'Jev Yarn',
    slug: 'discord-call',
    aliases: [],
    tagline: 'One game for everyone in the call',
    discordOnly: true,
  },
};

// Discord lists an app only if its content has none of what Discord calls
// adult content: sexually explicit material, violent content, drugs, alcohol,
// firearms and other regulated goods, and gambling (the App Discovery Content
// Requirements Policy, as of September 2026). So the call game takes Safe for
// Everyone's violence and sexual-content filters, Moderated for Teens'
// profanity filter (Discord does not rule out mild swearing), a filter of its
// own for drugs, alcohol, tobacco, guns and gambling, and the hate filter.
const REGULATED = {
  key: 'regulated',
  label: 'drugs, alcohol, tobacco, guns and gambling',
  question: 'Does this sentence involve drugs, alcohol, tobacco, guns or gambling?',
  criteria: {
    true: 'Drug use, drinking alcohol or being drunk, smoking or vaping, guns, ammunition, explosives or tactical gear, or betting and gambling',
    false: 'None of these; everyday things such as medicine taken as directed, coffee or soft drinks are fine',
  },
};
const filterOf = (code, key) => RATINGS[code].filters.find((f) => f.key === key);
RATINGS.D.filters = [filterOf('E', 'violence'), filterOf('E', 'sexual'), filterOf('T', 'profanity'), REGULATED, HATE];
export const DISCORD_CODE = 'D';
// The website's four rooms, in order.
export const RATING_CODES = Object.keys(RATINGS).filter((code) => !RATINGS[code].discordOnly);

// Inside Discord each call (Activity instance) gets its own private game.
// This checks an instance id as Discord passes it to the page.
export function isInstanceId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

// The name of a room's Durable Object: a public room by its rating code, a
// Discord call's game by instance and rating code.
export function roomObjectName(code, instance = null) {
  return instance ? `discord:${instance}:${code}` : `rating:${code}`;
}

// Which room a connection may open: a Discord call plays only its own game;
// the website offers its four rooms and never the Discord one.
export function roomAllowed(code, instance = null) {
  return instance ? code === DISCORD_CODE : RATING_CODES.includes(code);
}

// Rooms are found by their link slug, or by an older slug kept as an alias so
// links shared before the rename still open the same room.
export function ratingFromSlug(slug) {
  const s = String(slug || '').toLowerCase();
  return RATING_CODES.map((code) => RATINGS[code]).find((r) => r.slug === s || (r.aliases || []).includes(s)) || null;
}
// A candidate is filtered when an enabled filter's probability passes this.
export const MODERATION_THRESHOLD = 0.5;

export const DEFAULT_SETTINGS = {
  writingSeconds: 60,
  themeSeconds: 90,
  revealSeconds: 30,
  storyEndSeconds: 30,
  maxSentenceChars: 280,
  maxPlayers: 100,
};

export const LIMITS = {
  writingSeconds: [30, 120],
  themeSeconds: [30, 180],
  revealSeconds: [10, 120],
  storyEndSeconds: [10, 120],
  maxSentenceChars: [80, 500],
  maxPlayers: [2, 100],
  nick: 20,
  theme: 80,
};

// How much a candidate's "this would end the story" probability counts once
// the story is past its minimum length, growing to CLOSURE_MAX_WEIGHT at the max.
export const CLOSURE_MAX_WEIGHT = 0.5;
// The story ends when the winning sentence's closure probability reaches this
// (only once the minimum length is met). The maximum length is a hard stop.
export const CLOSURE_END_THRESHOLD = 0.6;

// Reveal: how many lines players can tap, how many "everyone else" lines the
// reveal carries, and how strongly taps move the room's default sliders
// (points per unit of relative dimension difference). Learned weights never
// drop below LEARN_FLOOR so no dimension is silenced for good.
export const TOP_N = 5;
export const OTHERS_N = 15;
export const LEARN_RATE = 5;
export const LEARN_FLOOR = 5;

// Candidates per detail request (closure + moderation questions). Keeps each
// request comfortably inside TypeSafe's per-request token budget.
export const JUDGE_CHUNK_SIZE = 20;

export function defaultWeights() {
  const w = {};
  for (const d of DIMENSIONS) w[d.key] = d.default;
  return w;
}

// Clamp incoming slider values to integers 0..100. If every slider is zero
// the defaults are used so judging always has a mix to work with.
export function normalizeWeights(input) {
  const w = {};
  let total = 0;
  for (const d of DIMENSIONS) {
    let v = Number(input && input[d.key]);
    if (!Number.isFinite(v)) v = d.default;
    v = Math.max(0, Math.min(100, Math.round(v)));
    w[d.key] = v;
    total += v;
  }
  return total === 0 ? defaultWeights() : w;
}

// Turn 0..100 sliders into fractions that sum to 1.
export function weightFractions(weights) {
  const w = normalizeWeights(weights);
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  const f = {};
  for (const d of DIMENSIONS) f[d.key] = w[d.key] / total;
  return f;
}

// Taps are feedback, never votes: a tap on a non-winning line moves the room's
// default sliders toward the dimensions where that line beat Jev's pick.
// `top` rows carry `dims` (probability per dimension); `taps` maps player id
// to the index tapped. Returns the new weights and simple agreement stats.
export function learnFromTaps(learned, top, taps) {
  const weights = normalizeWeights(learned);
  const winner = top && top[0];
  const acc = {};
  for (const d of DIMENSIONS) acc[d.key] = 0;
  let count = 0;
  let agreements = 0;
  if (winner) {
    for (const idx of Object.values(taps || {})) {
      const line = top[idx];
      if (!line) continue;
      count += 1;
      if (idx === 0) {
        agreements += 1;
        continue;
      }
      for (const d of DIMENSIONS) {
        const a = Number(line.dims && line.dims[d.key]) || 0;
        const b = Number(winner.dims && winner.dims[d.key]) || 0;
        const scale = Math.max(a, b, 1e-6);
        acc[d.key] += (a - b) / scale;
      }
    }
  }
  if (count > 0) {
    for (const d of DIMENSIONS) {
      weights[d.key] = Math.max(LEARN_FLOOR, Math.min(100, Math.round(weights[d.key] + (LEARN_RATE * acc[d.key]) / count)));
    }
  }
  return { weights: normalizeWeights(weights), agreements, taps: count };
}

function clampInt(v, [lo, hi], fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

export function sanitizeSettings(input, current = DEFAULT_SETTINGS) {
  const src = input || {};
  return {
    writingSeconds: clampInt(src.writingSeconds ?? current.writingSeconds, LIMITS.writingSeconds, current.writingSeconds),
    themeSeconds: clampInt(src.themeSeconds ?? current.themeSeconds, LIMITS.themeSeconds, current.themeSeconds),
    revealSeconds: clampInt(src.revealSeconds ?? current.revealSeconds, LIMITS.revealSeconds, current.revealSeconds),
    storyEndSeconds: clampInt(src.storyEndSeconds ?? current.storyEndSeconds, LIMITS.storyEndSeconds, current.storyEndSeconds),
    maxSentenceChars: clampInt(src.maxSentenceChars ?? current.maxSentenceChars, LIMITS.maxSentenceChars, current.maxSentenceChars),
    maxPlayers: clampInt(src.maxPlayers ?? current.maxPlayers, LIMITS.maxPlayers, current.maxPlayers),
  };
}

// Room settings are fixed per deployment: defaults above, overridable through
// plain [vars] in wrangler.toml (WRITING_SECONDS, THEME_SECONDS, REVEAL_SECONDS,
// STORY_END_SECONDS, MAX_SENTENCE_CHARS, MAX_PLAYERS).
export function settingsFromEnv(env) {
  const e = env || {};
  return sanitizeSettings({
    writingSeconds: e.WRITING_SECONDS,
    themeSeconds: e.THEME_SECONDS,
    revealSeconds: e.REVEAL_SECONDS,
    storyEndSeconds: e.STORY_END_SECONDS,
    maxSentenceChars: e.MAX_SENTENCE_CHARS,
    maxPlayers: e.MAX_PLAYERS,
  });
}

// The next theme setter: the first connected player whose join order is after
// the previous setter's, wrapping around to the earliest.
export function nextSetter(connectedSorted, afterOrder) {
  if (!connectedSorted || !connectedSorted.length) return null;
  return connectedSorted.find((p) => p.order > afterOrder) || connectedSorted[0];
}

// The writing round waits for a connected player who has not written, unless
// their app is in the background, or they sat out the last round and have not
// started typing in this one. Waiting for them would only run the clock down
// for everyone else; a slow typist is still waited for once they type.
export function holdsUpRound(player, round) {
  if (!player || !player.connected || !round || round.submissions[player.id]) return false;
  if (player.away) return false;
  return !(player.idleRounds > 0) || Boolean(round.typing && round.typing[player.id]);
}

// A round may close before its clock runs out once at least one line is in
// and nobody it waits for is left. Like the game itself, it needs two
// connected players.
export function everyoneHasWritten(players, round) {
  const connected = (players || []).filter((p) => p.connected);
  if (connected.length < 2 || !round) return false;
  return connected.some((p) => round.submissions[p.id]) && !connected.some((p) => holdsUpRound(p, round));
}

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Characters that print nothing yet change how text reads or compares:
// controls, format characters (zero-width spaces and joiners, bidirectional
// overrides, soft hyphens), private-use code points, and the few letters and
// symbols that render as blank space.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\u{115F}\u{1160}\u{3164}\u{FFA0}\u{2800}]/gu;

// Collapse whitespace, strip invisible characters and truncate player text.
// The limit counts code points, so an emoji at the end is never cut in half.
export function cleanText(text, maxLen) {
  if (typeof text !== 'string') return '';
  const stripped = text.normalize('NFC').replace(/\s+/g, ' ').replace(INVISIBLE, '');
  // A run of combining marks is capped at three, which is more than any real
  // script stacks; piling them up is how text is made to spill over its
  // neighbours.
  const tidy = stripped.replace(/(\p{M}{3})\p{M}+/gu, '$1');
  const collapsed = tidy.replace(/\s+/g, ' ').trim();
  return Array.from(collapsed).slice(0, maxLen).join('').trim();
}

// A token bucket: `burst` messages at once, then `perSecond` steadily. The
// clock can be injected for tests.
export class RateLimiter {
  constructor({ burst = 30, perSecond = 3 } = {}, clock = Date.now) {
    this.burst = burst;
    this.perSecond = perSecond;
    this.clock = clock;
    this.tokens = burst;
    this.last = clock();
  }

  allow() {
    const t = this.clock();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.perSecond);
    this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

// The key that groups connections from one network: the address itself for
// IPv4, the /64 prefix for IPv6, where one household or device usually holds
// a whole prefix. Null when the address is unknown (local development).
export function ipKey(ip) {
  if (typeof ip !== 'string' || !ip) return null;
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const missing = Math.max(0, 8 - left.length - right.length);
  const groups = [...left, ...Array(missing).fill('0'), ...right].map((g) => g.toLowerCase().replace(/^0+(?=.)/, ''));
  return `${groups.slice(0, 4).join(':')}::/64`;
}
