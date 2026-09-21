// The judge: turns a round's candidate sentences into TypeSafe requests, then
// mixes Jev's typed answers into a ranking in code.
//
// Requests per round (all sent in parallel):
//   - one "taste" request: one Choice per dimension over ALL candidates,
//     so each dimension yields a probability per candidate (its share)
//   - one "detail" request per chunk of candidates: a Noul per candidate for
//     "would this sentence end the story?" and a Noul per room filter
//     ("does it contain strong profanity?" ...)
// Jev never writes text and never sees player names.

import {
  DIMENSIONS,
  MODERATION_THRESHOLD,
  LENGTHS,
  CLOSURE_MAX_WEIGHT,
  CLOSURE_END_THRESHOLD,
  JUDGE_CHUNK_SIZE,
  weightFractions,
  chunk,
} from './rules.js';

export const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone';
export const MODEL = 'jev-latest';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
// 0 -> A, 25 -> Z, 26 -> AA ...
export function candidateId(i) {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    n -= 1;
    s = LETTERS[n % 26] + s;
    n = Math.floor(n / 26);
  }
  return s;
}

function storyState({ theme, sentences, candidates }) {
  const storySoFar = sentences.length
    ? sentences.map((t, i) => `${i + 1}. ${t}`).join('\n')
    : '(No sentences yet. The winning candidate becomes the opening line of the story.)';
  return {
    game: 'A party game: players each write one candidate for the next sentence of a shared comic story. A judge picks which candidate is added.',
    theme,
    story_so_far: storySoFar,
    candidates: candidates.map((c) => ({ id: c.id, sentence: c.text })),
  };
}

// Ranks every candidate on every taste dimension. Needs at least two candidates.
export function buildTasteRequest({ theme, sentences, candidates }) {
  const options = {};
  for (const c of candidates) options[c.id] = c.text;
  const questions = {};
  for (const d of DIMENSIONS) {
    questions[`dim_${d.key}`] = { type: 'choice', instructions: d.instructions, criteria: options };
  }
  return { state: storyState({ theme, sentences, candidates }), model: MODEL, questions };
}

// Closure and room-filter questions for one chunk of candidates.
export function buildDetailRequest({ theme, sentences, candidates, filters }) {
  const questions = {};
  for (const c of candidates) {
    questions[`end_${c.id}`] = {
      type: 'noul',
      instructions: `If this sentence were added next, would the story feel finished, like a satisfying final line? Sentence: "${c.text}"`,
      criteria: {
        true: 'The sentence resolves or wraps up the story: an ending, a closing punchline, a moral, a farewell, or a clear "the end" feeling; nothing important is left hanging.',
        false: 'The sentence continues or escalates the story, introduces new elements, or leaves obvious threads open.',
      },
    };
    for (const f of filters || []) {
      questions[`mod_${f.key}_${c.id}`] = {
        type: 'noul',
        instructions: `${f.question} Sentence: "${c.text}"`,
        criteria: f.criteria,
      };
    }
  }
  return { state: storyState({ theme, sentences, candidates }), model: MODEL, questions };
}

export function buildRequests(input) {
  const requests = [];
  if (input.candidates.length > 1) requests.push(buildTasteRequest(input));
  for (const part of chunk(input.candidates, JUDGE_CHUNK_SIZE)) {
    requests.push(buildDetailRequest({ ...input, candidates: part }));
  }
  return requests;
}

// Mix Jev's answers into shares, decide the winner, the filtered set and
// whether the story ends. Pure function so it can be unit tested.
export function scoreResults({ answers, candidates, weights, storyLength, length, filters }) {
  const fractions = weightFractions(weights);
  const single = candidates.length === 1;

  const rows = candidates.map((c) => {
    const dims = {};
    let composite = 0;
    for (const d of DIMENSIONS) {
      const p = single ? 1 : Number(answers[`dim_${d.key}`]?.probabilities?.[c.id]) || 0;
      dims[d.key] = p;
      composite += fractions[d.key] * p;
    }
    const closure = Number(answers[`end_${c.id}`]?.noul) || 0;
    const flags = [];
    for (const f of filters || []) {
      const p = Number(answers[`mod_${f.key}_${c.id}`]?.noul) || 0;
      if (p > MODERATION_THRESHOLD) flags.push(f.key);
    }
    return { id: c.id, composite, dims, closure, flags, filtered: flags.length > 0 };
  });

  // Closure pressure ramps from 0 at the minimum length to CLOSURE_MAX_WEIGHT
  // at the maximum, so long stories start favoring sentences that wrap up.
  const cfg = LENGTHS[length] || LENGTHS.medium;
  const nextLength = storyLength + 1;
  let ramp = 0;
  if (nextLength >= cfg.min) ramp = Math.min(1, (nextLength - cfg.min) / Math.max(1, cfg.max - cfg.min));
  const r = CLOSURE_MAX_WEIGHT * ramp;
  const closureSum = rows.reduce((s, x) => s + x.closure, 0);
  for (const x of rows) {
    const closureShare = closureSum > 0 ? x.closure / closureSum : 0;
    x.share = (1 - r) * x.composite + r * closureShare;
  }
  const total = rows.reduce((s, x) => s + x.share, 0) || 1;
  for (const x of rows) x.share = x.share / total;

  const ranked = [...rows].sort((a, b) => b.share - a.share);
  const eligible = ranked.filter((x) => !x.filtered);
  const winner = eligible[0] || null;

  let ends = false;
  let endReason = null;
  if (winner) {
    if (nextLength >= cfg.max) {
      ends = true;
      endReason = 'max';
    } else if (nextLength >= cfg.min && winner.closure >= CLOSURE_END_THRESHOLD) {
      ends = true;
      endReason = 'jev';
    }
  }
  return { ranked, winner, ends, endReason, closureWeight: r };
}

// ---------------------------------------------------------------------------
// Transport

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function callTypeSafe(apiKey, body, { fetchImpl = fetch, retries = 2, timeoutMs = 25000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(TYPESAFE_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (res.ok) return await res.json();
      const text = await res.text().catch(() => '');
      const retryable = res.status === 429 || res.status >= 500;
      lastErr = new Error(`TypeSafe ${res.status}: ${text.slice(0, 200)}`);
      if (!retryable) throw lastErr;
    } catch (err) {
      lastErr = err;
      if (err && err.name === 'AbortError') lastErr = new Error('TypeSafe request timed out');
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) await sleep(500 * 2 ** attempt);
  }
  throw lastErr;
}

// Development stand-in used only when MOCK_JUDGE=1 and no key is configured.
export function mockAnswers(request) {
  const ids = request.state.candidates.map((c) => c.id);
  const answers = {};
  const rand = () => Math.random();
  for (const [qid, q] of Object.entries(request.questions)) {
    const text = String(q.instructions).toLowerCase();
    if (q.type === 'choice') {
      const raw = ids.map(() => 0.2 + rand());
      const sum = raw.reduce((a, b) => a + b, 0);
      const probabilities = {};
      ids.forEach((id, i) => (probabilities[id] = raw[i] / sum));
      const choice = ids[raw.indexOf(Math.max(...raw))];
      answers[qid] = { type: 'choice', choice, probabilities, confidence: 0.3 };
    } else if (qid.startsWith('end_')) {
      const endsy = /the end|happily ever after|and that was that|forever/.test(text);
      answers[qid] = { type: 'noul', noul: endsy ? 0.85 : 0.05 + rand() * 0.25 };
    } else if (qid.startsWith('mod_profanity')) {
      answers[qid] = { type: 'noul', noul: /\bf[u*]ck|\bsh[i*]t\b/.test(text) ? 0.95 : 0.02 };
    } else if (q.type === 'noul') {
      answers[qid] = { type: 'noul', noul: 0.02 };
    }
  }
  return { model: 'mock', answers, usage: { input_tokens: 0, output_tokens: 0 } };
}

// Entry point used by the room. Returns { ranked, winner, ends, endReason, model, usage, requests }.
export async function judgeRound(env, input) {
  const requests = buildRequests(input);
  let responses;
  if (env.TYPESAFE_API_KEY) {
    responses = await Promise.all(requests.map((body) => callTypeSafe(env.TYPESAFE_API_KEY, body)));
  } else if (env.MOCK_JUDGE === '1') {
    await sleep(800);
    responses = requests.map(mockAnswers);
  } else {
    throw new Error('The judge is not configured: set the TYPESAFE_API_KEY secret.');
  }
  const answers = {};
  const usage = { input_tokens: 0, output_tokens: 0 };
  let model = null;
  for (const res of responses) {
    Object.assign(answers, res.answers || {});
    usage.input_tokens += Number(res.usage?.input_tokens) || 0;
    usage.output_tokens += Number(res.usage?.output_tokens) || 0;
    model = res.model || model;
  }
  const scored = scoreResults({
    answers,
    candidates: input.candidates,
    weights: input.weights,
    storyLength: input.sentences.length,
    length: input.length,
    filters: input.filters,
  });
  return { ...scored, model, usage, requests: requests.length };
}
