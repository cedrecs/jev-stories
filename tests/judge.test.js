import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRequests,
  buildDetailRequest,
  scoreResults,
  candidateId,
  mockAnswers,
  buildStoryScoreRequest,
  summarizeStoryScore,
} from '../src/judge.js';
import { EMOJIS, pickEmoji } from '../src/rules.js';
import {
  normalizeWeights,
  weightFractions,
  sanitizeSettings,
  settingsFromEnv,
  cleanText,
  learnFromTaps,
  nextSetter,
  ratingFromSlug,
  RATINGS,
  DIMENSIONS,
  JUDGE_CHUNK_SIZE,
} from '../src/rules.js';

const cands = [
  { id: 'A', text: 'The goose demanded a refund.' },
  { id: 'B', text: 'And so the goose retired to Florida, the end.' },
  { id: 'C', text: 'Nothing happened.' },
];

function choice(probs) {
  const pick = Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0];
  return { type: 'choice', choice: pick, probabilities: probs, confidence: 0.5 };
}
function noul(p) {
  return { type: 'noul', noul: p };
}

function answersWhereAWins() {
  const a = {};
  for (const d of DIMENSIONS) a[`dim_${d.key}`] = choice({ A: 0.6, B: 0.3, C: 0.1 });
  a.end_A = noul(0.05);
  a.end_B = noul(0.9);
  a.end_C = noul(0.1);
  for (const id of ['A', 'B', 'C']) {
    for (const f of RATINGS.T.filters) a[`mod_${f.key}_${id}`] = noul(0.02);
  }
  return a;
}

test('candidateId labels A..Z then AA', () => {
  assert.equal(candidateId(0), 'A');
  assert.equal(candidateId(25), 'Z');
  assert.equal(candidateId(26), 'AA');
});

test('buildRequests sends one taste request plus detail chunks of JUDGE_CHUNK_SIZE', () => {
  const many = Array.from({ length: 45 }, (_, i) => ({ id: candidateId(i), text: `Line number ${i}.` }));
  const reqs = buildRequests({ theme: 'Geese', sentences: ['Once there was a goose.'], candidates: many, filters: RATINGS.E.filters });
  assert.equal(reqs.length, 1 + Math.ceil(45 / JUDGE_CHUNK_SIZE));
  const taste = reqs[0];
  assert.equal(Object.keys(taste.questions).length, DIMENSIONS.length);
  assert.equal(Object.keys(taste.questions.dim_funny.criteria).length, 45);
  assert.equal(taste.questions.dim_funny.criteria.A, 'Line number 0.');
  const detail = reqs[1];
  assert.equal(detail.state.candidates.length, JUDGE_CHUNK_SIZE);
  // per candidate: closure + one question per room filter
  assert.equal(Object.keys(detail.questions).length, JUDGE_CHUNK_SIZE * (1 + RATINGS.E.filters.length));
  assert.match(detail.state.story_so_far, /^1\. Once there was a goose\./);
  // question ids are unique across the whole batch
  const ids = reqs.flatMap((r) => Object.keys(r.questions));
  assert.equal(new Set(ids).size, ids.length);
});

test('a single candidate gets no taste request and no story text yet', () => {
  const reqs = buildRequests({ theme: 'X', sentences: [], candidates: [cands[0]], filters: RATINGS.A.filters });
  assert.equal(reqs.length, 1);
  assert.deepEqual(Object.keys(reqs[0].questions), ['end_A', 'mod_hateful_A']);
  assert.match(reqs[0].state.story_so_far, /No sentences yet/);
});

test('room filters produce one Noul per filter with the room wording', () => {
  const req = buildDetailRequest({ theme: 'T', sentences: [], candidates: [cands[0]], filters: RATINGS.E.filters });
  assert.equal(Object.keys(req.questions).length, 1 + 4);
  assert.match(req.questions.mod_profanity_A.instructions, /any swearing/);
  assert.match(req.questions.mod_profanity_A.instructions, /The goose demanded a refund/);
  const teen = buildDetailRequest({ theme: 'T', sentences: [], candidates: [cands[0]], filters: RATINGS.T.filters });
  assert.match(teen.questions.mod_profanity_A.instructions, /strong profanity/);
  const adult = buildDetailRequest({ theme: 'T', sentences: [], candidates: [cands[0]], filters: RATINGS.A.filters });
  assert.deepEqual(Object.keys(adult.questions), ['end_A', 'mod_hateful_A']);
});

test('weights mix into shares that sum to one, and the top share wins', () => {
  const res = scoreResults({
    answers: answersWhereAWins(),
    candidates: cands,
    weights: normalizeWeights({ funny: 50, continuity: 20, theme: 15, surprise: 15 }),
    storyLength: 1,
    length: 'medium',
    filters: RATINGS.T.filters,
  });
  const sum = res.ranked.reduce((s, r) => s + r.share, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  assert.equal(res.winner.id, 'A');
  assert.equal(res.ends, false);
  assert.equal(res.closureWeight, 0);
});

test('a filter that fires disqualifies the line and records which filter', () => {
  const a = answersWhereAWins();
  a.mod_profanity_A = noul(0.9);
  const res = scoreResults({ answers: a, candidates: cands, weights: normalizeWeights({}), storyLength: 1, length: 'medium', filters: RATINGS.T.filters });
  const rowA = res.ranked.find((r) => r.id === 'A');
  assert.equal(rowA.filtered, true);
  assert.deepEqual(rowA.flags, ['profanity']);
  assert.equal(res.winner.id, 'B');

  // Absolute Degenerates only asks about hate, so the same answers do not filter A.
  const adult = scoreResults({ answers: a, candidates: cands, weights: normalizeWeights({}), storyLength: 1, length: 'medium', filters: RATINGS.A.filters });
  assert.equal(adult.winner.id, 'A');
});

test('every candidate filtered leaves no winner', () => {
  const a = answersWhereAWins();
  for (const id of ['A', 'B', 'C']) a[`mod_hateful_${id}`] = noul(0.99);
  const res = scoreResults({ answers: a, candidates: cands, weights: normalizeWeights({}), storyLength: 1, length: 'medium', filters: RATINGS.A.filters });
  assert.equal(res.winner, null);
  assert.equal(res.ends, false);
});

test('closure pressure grows with length and a concluding winner ends the story past the minimum', () => {
  const a = answersWhereAWins();
  const atMax = scoreResults({ answers: a, candidates: cands, weights: normalizeWeights({}), storyLength: 6, length: 'short', filters: [] });
  assert.equal(atMax.ends, true);
  assert.equal(atMax.endReason, 'max');
  assert.ok(atMax.closureWeight > 0.49);

  const b = answersWhereAWins();
  for (const d of DIMENSIONS) b[`dim_${d.key}`] = choice({ A: 0.2, B: 0.7, C: 0.1 });
  const atMin = scoreResults({ answers: b, candidates: cands, weights: normalizeWeights({}), storyLength: 3, length: 'short', filters: [] });
  assert.equal(atMin.winner.id, 'B');
  assert.equal(atMin.ends, true);
  assert.equal(atMin.endReason, 'jev');
});

test('learnFromTaps moves defaults toward dimensions where tapped lines beat the winner, and counts agreement', () => {
  const top = [
    { index: 0, dims: { funny: 0.6, continuity: 0.5, theme: 0.5, surprise: 0.1 } },
    { index: 1, dims: { funny: 0.3, continuity: 0.5, theme: 0.5, surprise: 0.6 } },
  ];
  const start = normalizeWeights({ funny: 50, continuity: 20, theme: 15, surprise: 15 });
  const all = learnFromTaps(start, top, { p1: 1, p2: 1, p3: 1 });
  assert.equal(all.taps, 3);
  assert.equal(all.agreements, 0);
  assert.ok(all.weights.surprise > start.surprise, 'surprise goes up');
  assert.ok(all.weights.funny < start.funny, 'funny goes down');
  assert.equal(all.weights.continuity, start.continuity, 'tied dimensions do not move');

  const agree = learnFromTaps(start, top, { p1: 0, p2: 0 });
  assert.equal(agree.agreements, 2);
  assert.deepEqual(agree.weights, start);

  const mixed = learnFromTaps(start, top, { p1: 0, p2: 1 });
  assert.ok(mixed.weights.surprise > start.surprise && mixed.weights.surprise < all.weights.surprise, 'a split room moves less');

  const none = learnFromTaps(start, top, {});
  assert.deepEqual(none.weights, start);
  assert.equal(none.taps, 0);

  const clamped = learnFromTaps({ funny: 100, continuity: 0, theme: 0, surprise: 0 }, top, { p1: 1 });
  assert.ok(clamped.weights.funny <= 100 && clamped.weights.surprise >= 0);
});

test('nextSetter takes the next join order and wraps around', () => {
  const players = [
    { id: 'a', order: 1 },
    { id: 'c', order: 3 },
    { id: 'e', order: 5 },
  ];
  assert.equal(nextSetter(players, 0).id, 'a');
  assert.equal(nextSetter(players, 1).id, 'c');
  assert.equal(nextSetter(players, 3).id, 'e');
  assert.equal(nextSetter(players, 5).id, 'a');
  assert.equal(nextSetter([], 5), null);
});

test('rooms are looked up by slug and settings are clamped from the environment', () => {
  assert.equal(ratingFromSlug('safe-for-everyone').code, 'E');
  assert.equal(ratingFromSlug('moderated-for-teens').code, 'T');
  assert.equal(ratingFromSlug('mature-audience-only').code, 'M');
  assert.equal(ratingFromSlug('Absolute-Degenerates').code, 'A');
  assert.equal(ratingFromSlug('teen').code, 'T', 'links from before the rename still work');
  assert.equal(ratingFromSlug('ADULT').code, 'A');
  assert.equal(ratingFromSlug('nope'), null);
  const s = settingsFromEnv({ WRITING_SECONDS: '999', MAX_PLAYERS: '5000', REVEAL_SECONDS: 'abc' });
  assert.equal(s.writingSeconds, 120);
  assert.equal(s.maxPlayers, 100);
  assert.equal(s.revealSeconds, 30);
  const d = sanitizeSettings({ writingSeconds: 5 });
  assert.equal(d.writingSeconds, 30);
});

test('normalizeWeights clamps and falls back to defaults when everything is zero', () => {
  const w = normalizeWeights({ funny: 250, continuity: -4, theme: 'nope', surprise: 10.6 });
  assert.equal(w.funny, 100);
  assert.equal(w.continuity, 0);
  assert.equal(w.theme, 15);
  assert.equal(w.surprise, 11);
  const zero = normalizeWeights({ funny: 0, continuity: 0, theme: 0, surprise: 0 });
  assert.equal(zero.funny, 50);
  const f = weightFractions({ funny: 50, continuity: 50, theme: 0, surprise: 0 });
  assert.equal(f.funny, 0.5);
});

test('cleanText strips control characters, collapses whitespace and truncates', () => {
  assert.equal(cleanText('  hello \x07  world\n\nagain  ', 100), 'hello world again');
  assert.equal(cleanText('abcdef', 3), 'abc');
  assert.equal(cleanText(42, 10), '');
});

test('mockAnswers returns well-formed answers for every question and flags mock profanity', () => {
  const dirty = [...cands, { id: 'D', text: 'This fucking goose again.' }];
  const reqs = buildRequests({ theme: 'T', sentences: [], candidates: dirty, filters: RATINGS.T.filters });
  const answers = {};
  for (const req of reqs) {
    const res = mockAnswers(req);
    for (const [qid, q] of Object.entries(req.questions)) {
      assert.ok(res.answers[qid], `missing answer for ${qid}`);
      if (q.type === 'choice') {
        const sum = Object.values(res.answers[qid].probabilities).reduce((s, p) => s + p, 0);
        assert.ok(Math.abs(sum - 1) < 1e-9);
      }
    }
    Object.assign(answers, res.answers);
  }
  const scored = scoreResults({ answers, candidates: dirty, weights: normalizeWeights({}), storyLength: 0, length: 'medium', filters: RATINGS.T.filters });
  assert.ok(scored.winner);
  assert.equal(scored.ranked.find((r) => r.id === 'D').filtered, true);
});

test('default timings: 90 s to set a theme, 60 s to write a line, 30 s for the reveal and the story end', () => {
  const s = settingsFromEnv({});
  assert.equal(s.themeSeconds, 90);
  assert.equal(s.writingSeconds, 60);
  assert.equal(s.revealSeconds, 30);
  assert.equal(s.storyEndSeconds, 30);
});

test('room names', () => {
  assert.deepEqual(
    ['E', 'T', 'M', 'A'].map((c) => RATINGS[c].label),
    ['Safe for Everyone', 'Moderated for Teens', 'Mature Audience Only', 'Absolute Degenerates'],
  );
  assert.ok(Object.values(RATINGS).every((r) => r.filters.some((f) => f.key === 'hateful')), 'hate is filtered in every room');
});

test('pickEmoji accepts only listed icons and falls back by join order', () => {
  assert.equal(EMOJIS.length, 32);
  assert.equal(new Set(EMOJIS).size, 32, 'no duplicates');
  assert.equal(pickEmoji(EMOJIS[5]), EMOJIS[5]);
  assert.equal(pickEmoji('<img src=x>'), null);
  assert.equal(pickEmoji({ toString: () => EMOJIS[0] }), null, 'objects are not coerced');
  assert.equal(pickEmoji('nope', 3), EMOJIS[3]);
  assert.equal(pickEmoji(undefined, 35), EMOJIS[3], 'wraps around');
});

test('the story score asks one Score question per dimension over the whole story', () => {
  const req = buildStoryScoreRequest({ theme: 'Geese', sentences: ['A goose appeared.', 'It left. The end.'] });
  assert.match(req.state.story, /^1\. A goose appeared\.\n2\. It left\. The end\.$/);
  assert.equal(Object.keys(req.questions).length, DIMENSIONS.length);
  for (const d of DIMENSIONS) {
    const q = req.questions[`story_${d.key}`];
    assert.equal(q.type, 'score');
    assert.equal(q.criteria.length, 5);
  }
});

test('the story score mixes the four dimensions with the story weights, and refuses partial answers', () => {
  const full = {
    story_funny: { score: 4 },
    story_continuity: { score: 2 },
    story_theme: { score: 3 },
    story_surprise: { score: 0 },
  };
  const s = summarizeStoryScore(full, { funny: 50, continuity: 50, theme: 0, surprise: 0 });
  assert.equal(s.overall, 75, 'half of 100% funny plus half of 50% flow');
  assert.equal(s.dims.funny.value, 1);
  assert.equal(s.dims.funny.label, 'Hilarious');
  assert.equal(s.dims.surprise.label, 'Predictable');
  assert.equal(s.dims.continuity.label, 'Mostly coherent');
  const fractional = summarizeStoryScore({ ...full, story_funny: { score: 2.6 } }, { funny: 100, continuity: 0, theme: 0, surprise: 0 });
  assert.equal(fractional.overall, 65);
  assert.equal(fractional.dims.funny.label, 'Very funny', 'label follows the nearest level');
  const { story_theme: _dropped, ...partial } = full;
  assert.equal(summarizeStoryScore(partial, {}), null);
  assert.equal(summarizeStoryScore({ ...full, story_theme: { score: 'x' } }, {}), null);
});

test('the mock judge answers story score questions', () => {
  const req = buildStoryScoreRequest({ theme: 'T', sentences: ['One.'] });
  const res = mockAnswers(req);
  const s = summarizeStoryScore(res.answers, {});
  assert.ok(s && s.overall >= 0 && s.overall <= 100);
});
