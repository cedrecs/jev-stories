// Worker entry: answers room lookups and hands WebSocket upgrades to the
// room's Durable Object. Everything else is a static asset.
//
// There are four fixed rooms: Safe for Everyone, Moderated for Teens, Mature
// Audience Only and Absolute Degenerates, keyed internally by the codes E, T,
// M and A. A room's Durable Object is created on first contact and lives on
// from then.

import { Room } from './room.js';
import { RATINGS, RATING_CODES } from './rules.js';

export { Room };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function roomStub(env, code) {
  return env.ROOM.get(env.ROOM.idFromName(`rating:${code}`));
}

function publicRoom(code, info) {
  const r = RATINGS[code];
  return {
    code,
    label: r.label,
    slug: r.slug,
    aliases: r.aliases || [],
    tagline: r.tagline,
    // Hate and harassment are filtered in every room; the home screen says so
    // once, so each room lists only its own extra filters.
    filters: r.filters.filter((f) => f.key !== 'hateful').map((f) => f.label),
    players: info && info.exists ? info.players : 0,
    phase: info && info.exists ? info.phase : 'paused',
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/health') {
      const judge = env.TYPESAFE_API_KEY ? 'jev' : env.MOCK_JUDGE === '1' ? 'mock' : 'unconfigured';
      return json({ ok: true, judge });
    }

    if (path === '/api/rooms' && request.method === 'GET') {
      const infos = await Promise.all(RATING_CODES.map((code) => roomStub(env, code).info()));
      return json({ rooms: RATING_CODES.map((code, i) => publicRoom(code, infos[i])) });
    }

    let m = path.match(/^\/api\/rooms\/([A-Za-z])$/);
    if (m && request.method === 'GET') {
      const code = m[1].toUpperCase();
      if (!RATINGS[code]) return json({ error: 'No such room' }, 404);
      const info = await roomStub(env, code).info();
      return json(publicRoom(code, info));
    }

    m = path.match(/^\/ws\/([A-Za-z])$/);
    if (m) {
      const code = m[1].toUpperCase();
      if (!RATINGS[code]) return new Response('No such room', { status: 404 });
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected a WebSocket upgrade', { status: 426 });
      }
      const stub = roomStub(env, code);
      await stub.create(code);
      return stub.fetch(request);
    }

    if (path.startsWith('/api/') || path.startsWith('/ws/')) {
      return json({ error: 'Not found' }, 404);
    }
    return env.ASSETS.fetch(request);
  },
};
