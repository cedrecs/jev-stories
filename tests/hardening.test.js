import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, normalizeLength, RateLimiter, ipKey, LENGTHS, RATINGS, DIMENSIONS, normalizeWeights, isInstanceId, roomObjectName } from '../src/rules.js';
import { scoreResults, UNCHECKED, buildTextCheckRequest, checkText } from '../src/judge.js';
import { securityHeaders, allowedOrigins, withHeaders, forwardToCanonical } from '../src/headers.js';
import { linkPreview } from '../src/preview.js';

test('cleanText strips invisible and bidirectional characters and counts code points', () => {
  const zwsp = String.fromCodePoint(0x200b);
  const rlo = String.fromCodePoint(0x202e);
  const shy = String.fromCodePoint(0xad);
  const filler = String.fromCodePoint(0x3164);
  assert.equal(cleanText(`Fo${zwsp}x`, 20), 'Fox');
  assert.equal(cleanText(`${rlo}Fox`, 20), 'Fox');
  assert.equal(cleanText(`F${shy}ox`, 20), 'Fox');
  assert.equal(cleanText(`Fox${filler}`, 20), 'Fox');
  assert.equal(cleanText(`${zwsp}${zwsp}`, 20), '', 'nothing visible leaves nothing');
  const fox = String.fromCodePoint(0x1f98a);
  assert.equal(cleanText(`${fox}${fox}${fox}`, 2), `${fox}${fox}`, 'the limit counts an emoji as one character');
  assert.equal(cleanText('a \x07 b', 10), 'a b', 'a stripped control leaves no double space');
  const acute = '\u{0301}';
  // q has no composed form with an acute, so normalization leaves the marks alone.
  assert.equal(cleanText(`q${acute.repeat(20)}x`, 40), `q${acute.repeat(3)}x`, 'stacked combining marks are capped at three');
  assert.equal(cleanText(`e${acute}`, 10), 'é', 'normal accents are composed and kept');
  assert.equal(cleanText('  hello \x07  world\n\nagain  ', 100), 'hello world again');
});

test('normalizeLength accepts only real story lengths', () => {
  assert.equal(normalizeLength('short'), 'short');
  assert.equal(normalizeLength('long'), 'long');
  assert.equal(normalizeLength('__proto__'), 'medium');
  assert.equal(normalizeLength('constructor'), 'medium');
  assert.equal(normalizeLength('toString'), 'medium');
  assert.equal(normalizeLength(42), 'medium');
  assert.equal(normalizeLength(undefined), 'medium');
  assert.equal(LENGTHS['__proto__'], Object.prototype, 'the lookup this guards against really is inherited');
});

test('RateLimiter allows a burst, then a steady rate that refills with time', () => {
  let t = 0;
  const rl = new RateLimiter({ burst: 3, perSecond: 1 }, () => t);
  assert.deepEqual([rl.allow(), rl.allow(), rl.allow(), rl.allow()], [true, true, true, false]);
  t = 500;
  assert.equal(rl.allow(), false, 'half a token is not enough');
  t = 1000;
  assert.equal(rl.allow(), true);
  assert.equal(rl.allow(), false);
  t = 100000;
  assert.deepEqual([rl.allow(), rl.allow(), rl.allow(), rl.allow()], [true, true, true, false], 'the bucket never holds more than the burst');
});

test('ipKey keeps IPv4 addresses and groups IPv6 by /64', () => {
  assert.equal(ipKey('203.0.113.9'), '203.0.113.9');
  assert.equal(ipKey('2001:db8:85a3::8a2e:370:7334'), '2001:db8:85a3:0::/64');
  assert.equal(ipKey('2001:db8:85a3:0:0:8a2e:370:7335'), ipKey('2001:db8:85a3::8a2e:370:7334'), 'the same /64 in two spellings');
  assert.equal(ipKey('2001:DB8:85A3:0001::1'), '2001:db8:85a3:1::/64');
  assert.notEqual(ipKey('2001:db8:85a3:1::1'), ipKey('2001:db8:85a3:2::1'));
  assert.equal(ipKey(''), null);
  assert.equal(ipKey(null), null);
});

test('a line whose room-filter answer is missing cannot win (fail closed)', () => {
  const cands = [
    { id: 'A', text: 'A line.' },
    { id: 'B', text: 'Another line.' },
  ];
  const answers = {};
  for (const d of DIMENSIONS) answers[`dim_${d.key}`] = { type: 'choice', choice: 'A', probabilities: { A: 0.8, B: 0.2 }, confidence: 0.5 };
  answers.end_A = { noul: 0.1 };
  answers.end_B = { noul: 0.1 };
  for (const f of RATINGS.E.filters) answers[`mod_${f.key}_B`] = { noul: 0.01 };
  // A has every filter answered except swearing.
  for (const f of RATINGS.E.filters) if (f.key !== 'profanity') answers[`mod_${f.key}_A`] = { noul: 0.01 };
  const args = { candidates: cands, weights: normalizeWeights({}), storyLength: 0, length: 'medium', filters: RATINGS.E.filters };
  const res = scoreResults({ answers, ...args });
  const a = res.ranked.find((r) => r.id === 'A');
  assert.equal(a.filtered, true);
  assert.deepEqual(a.flags, [UNCHECKED]);
  assert.equal(res.winner.id, 'B', 'the favourite loses to the line that was checked');
  // A garbled answer counts as missing too.
  answers.mod_profanity_A = { noul: 'yes' };
  assert.equal(scoreResults({ answers, ...args }).ranked.find((r) => r.id === 'A').filtered, true);
  // A real answer below the threshold clears it.
  answers.mod_profanity_A = { noul: 0.1 };
  assert.equal(scoreResults({ answers, ...args }).ranked.find((r) => r.id === 'A').filtered, false);
});

test('nickname and theme checks ask one Noul per room filter, and the mock judge answers them', async () => {
  const req = buildTextCheckRequest({ text: 'Captain Goose', filters: RATINGS.E.filters });
  assert.deepEqual(Object.keys(req.questions), ['mod_violence', 'mod_sexual', 'mod_profanity', 'mod_hateful']);
  assert.match(req.questions.mod_profanity.instructions, /Captain Goose/);
  assert.equal(req.state.text, 'Captain Goose');
  const clean = await checkText({ MOCK_JUDGE: '1' }, { text: 'Captain Goose', filters: RATINGS.E.filters });
  assert.deepEqual(clean.flags, []);
  const rude = await checkText({ MOCK_JUDGE: '1' }, { text: 'Captain Fucking Goose', filters: RATINGS.E.filters });
  assert.deepEqual(rude.flags, ['profanity']);
  const none = await checkText({}, { text: 'x', filters: [] });
  assert.deepEqual(none.flags, [], 'no filters means nothing to ask');
  await assert.rejects(checkText({}, { text: 'x', filters: RATINGS.M.filters }), /not configured/);
  const degenerate = await checkText({}, { text: 'anything', filters: RATINGS.A.filters });
  assert.deepEqual(degenerate.flags, [], 'Absolute Degenerates checks nothing, so no judge is needed');
});

test('security headers: a strict policy, the room socket on this host, framing by Discord only, HSTS only over HTTPS', () => {
  const live = securityHeaders(new URL('https://jev-stories.jev-stories.workers.dev/safe-for-everyone'));
  const csp = live['Content-Security-Policy'];
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self';/);
  assert.match(csp, /frame-ancestors https:\/\/discord\.com https:\/\/\*\.discord\.com https:\/\/\*\.discordsays\.com;/, 'only Discord may frame the page');
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /font-src 'self';/, 'fonts come from this site only');
  assert.match(csp, /style-src-elem 'self';/);
  assert.doesNotMatch(csp, /googleapis|gstatic/);
  assert.match(csp, /connect-src 'self' wss:\/\/jev-stories\.jev-stories\.workers\.dev ws:\/\/jev-stories\.jev-stories\.workers\.dev wss:\/\/\*\.discordsays\.com;/);
  assert.equal(live['Strict-Transport-Security'], 'max-age=31536000');
  assert.equal(live['X-Content-Type-Options'], 'nosniff');
  assert.equal(live['X-Frame-Options'], undefined, 'it cannot name Discord, so frame-ancestors does the job');
  const local = securityHeaders(new URL('http://localhost:8787/'));
  assert.equal(local['Strict-Transport-Security'], undefined, 'local development runs on plain HTTP');
  assert.match(local['Content-Security-Policy'], /ws:\/\/localhost:8787/);
  const res = withHeaders(new Response('x', { status: 201, headers: { 'Content-Type': 'text/plain' } }), local);
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('Content-Type'), 'text/plain', 'existing headers survive');
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
});

test('Discord: room connections from the Activity address, and private rooms per call', () => {
  const url = new URL('https://jev-stories.jev-stories.workers.dev/ws/E');
  assert.deepEqual(allowedOrigins(url, ''), ['https://jev-stories.jev-stories.workers.dev'], 'no Discord app set up: this site only');
  assert.deepEqual(allowedOrigins(url, '123456789012345678'), ['https://jev-stories.jev-stories.workers.dev', 'https://123456789012345678.discordsays.com']);
  assert.deepEqual(allowedOrigins(url, 'evil.example/x'), ['https://jev-stories.jev-stories.workers.dev'], 'only a numeric id counts');
  assert.equal(roomObjectName('E'), 'rating:E', 'the public rooms keep their saved state');
  assert.equal(roomObjectName('A', 'i-1234-gc-5678'), 'discord:i-1234-gc-5678:A');
  assert.equal(isInstanceId('i-1234567890123456789-gc-123-456'), true);
  assert.equal(isInstanceId('../rating:E'), false);
  assert.equal(isInstanceId(''), false);
  assert.equal(isInstanceId('x'.repeat(129)), false);
  assert.equal(isInstanceId(null), false);
});

test('link previews: the game card at the root, a card per room, absolute URLs', () => {
  const home = linkPreview(new URL('https://jev-stories.jev-stories.workers.dev/'));
  assert.equal(home.title, null, 'the page keeps its own title');
  assert.equal(home.url, 'https://jev-stories.jev-stories.workers.dev/');
  assert.equal(home.image, 'https://jev-stories.jev-stories.workers.dev/icons/og-image.png');
  const room = linkPreview(new URL('https://jev-stories.jev-stories.workers.dev/safe-for-everyone'));
  assert.equal(room.title, 'Join Safe for Everyone');
  assert.equal(room.tagline, 'Clean fun for all ages');
  assert.equal(room.url, 'https://jev-stories.jev-stories.workers.dev/safe-for-everyone');
  const old = linkPreview(new URL('https://example.test/teen/'));
  assert.equal(old.title, 'Join Moderated for Teens', 'old slugs get the room card');
  assert.equal(old.url, 'https://example.test/moderated-for-teens', 'and point at the current link');
  assert.equal(linkPreview(new URL('https://example.test/nope')).title, null);
});

test('the old workers.dev address forwards page visits only', () => {
  const old = 'https://jev-stories.jev-stories.workers.dev';
  const req = (path, dest = 'document', method = 'GET', base = old) => new Request(base + path, { method, headers: dest ? { 'Sec-Fetch-Dest': dest } : {} });
  const fwd = (r, host = 'jev-yarn.jevie.app') => forwardToCanonical(r, new URL(r.url), host);
  const moved = fwd(req('/safe-for-everyone?x=1'));
  assert.equal(moved.status, 301);
  assert.equal(moved.headers.get('Location'), 'https://jev-yarn.jevie.app/safe-for-everyone?x=1', 'the path and query come along');
  assert.equal(fwd(req('/app.js', 'script')), null, 'files keep answering, so open pages finish their games');
  assert.equal(fwd(req('/api/rooms', 'empty')), null, 'the room list keeps answering');
  assert.equal(fwd(req('/', null)), null, 'no Sec-Fetch-Dest (link previews, older browsers): served as before');
  assert.equal(fwd(req('/?frame_id=f&instance_id=i&platform=mobile')), null, 'a Discord launch is never forwarded');
  assert.equal(fwd(req('/', 'iframe')), null);
  assert.equal(fwd(req('/', 'document', 'POST')), null);
  assert.equal(fwd(req('/', 'document', 'GET', 'https://jev-yarn.jevie.app')), null, 'the new address itself');
  assert.equal(fwd(req('/'), ''), null, 'staging sets no address, so nothing moves');
  assert.equal(forwardToCanonical(req('/'), new URL(old), undefined), null);
});
