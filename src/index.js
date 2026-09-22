// Worker entry: answers room lookups and hands WebSocket upgrades to the
// room's Durable Object. Everything else is a static asset, served through
// the Worker so that every response carries the security headers.
//
// There are four fixed rooms: Safe for Everyone, Moderated for Teens, Mature
// Audience Only and Absolute Degenerates, keyed internally by the codes E, T,
// M and A. A room's Durable Object is created on first contact and lives on
// from then.

import { Room } from './room.js';
import { RATINGS, RATING_CODES } from './rules.js';
import { securityHeaders, withHeaders } from './headers.js';
import { withPreview } from './preview.js';

export { Room };

// The room list asks every room object for its state. One answer serves all
// callers for this long, so a burst of requests never becomes a burst of
// room calls.
const ROOMS_CACHE_MS = 2000;
let roomsCache = { at: 0, promise: null };

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
    // Every filter the room applies, hate and harassment included. Absolute
    // Degenerates has none.
    filters: r.filters.map((f) => f.label),
    players: info && info.exists ? info.players : 0,
    phase: info && info.exists ? info.phase : 'paused',
  };
}

function roomList(env) {
  const t = Date.now();
  if (!roomsCache.promise || t - roomsCache.at > ROOMS_CACHE_MS) {
    const promise = Promise.all(RATING_CODES.map((code) => roomStub(env, code).info())).then((infos) =>
      RATING_CODES.map((code, i) => publicRoom(code, infos[i])),
    );
    roomsCache = { at: t, promise };
    promise.catch(() => {
      if (roomsCache.promise === promise) roomsCache = { at: 0, promise: null };
    });
  }
  return roomsCache.promise;
}

async function route(request, env, url) {
  const path = url.pathname;

  if (path === '/api/health') {
    const judge = env.TYPESAFE_API_KEY ? 'jev' : env.MOCK_JUDGE === '1' ? 'mock' : 'unconfigured';
    return json({ ok: true, judge });
  }

  if (path === '/api/rooms' && request.method === 'GET') {
    return json({ rooms: await roomList(env) });
  }

  let m = path.match(/^\/api\/rooms\/([A-Za-z])$/);
  if (m && request.method === 'GET') {
    const code = m[1].toUpperCase();
    if (!RATINGS[code]) return json({ error: 'No such room' }, 404);
    const rooms = await roomList(env);
    return json(rooms.find((r) => r.code === code));
  }

  m = path.match(/^\/ws\/([A-Za-z])$/);
  if (m) {
    const code = m[1].toUpperCase();
    if (!RATINGS[code]) return new Response('No such room', { status: 404 });
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    // A browser always sends the page's origin: only this site's own pages
    // may open a room connection, so another website cannot play through a
    // visitor's browser.
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return new Response('Forbidden', { status: 403 });
    const stub = roomStub(env, code);
    await stub.create(code);
    return stub.fetch(request);
  }

  if (path.startsWith('/api/') || path.startsWith('/ws/')) {
    return json({ error: 'Not found' }, 404);
  }
  // Pages get their link-preview tags filled in on the way out.
  const asset = await env.ASSETS.fetch(request);
  return request.method === 'GET' ? withPreview(asset, url) : asset;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let response;
    try {
      response = await route(request, env, url);
    } catch (err) {
      console.error('request failed', err);
      response = json({ error: 'Something went wrong' }, 500);
    }
    // A WebSocket handshake goes back untouched.
    if (response.status === 101) return response;
    return withHeaders(response, securityHeaders(url));
  },
};
