// Security headers for every response the Worker returns. Static files come
// through the Worker too (run_worker_first in wrangler.toml), so the page,
// the script and the service worker all carry them.
//
// The content security policy allows exactly what the app uses: its own
// files (fonts included); style attributes, which the pie and the progress
// bars carry their data in; and the room WebSocket, on this host or, inside
// Discord, on the Activity's discordsays.com address. Scripts come only from
// this site. Only Discord may show the page in a frame, for the Activity.

export function securityHeaders(url) {
  const host = /^[a-z0-9.:\[\]-]+$/i.test(url.host) ? url.host : '';
  const sockets = host ? ` wss://${host} ws://${host}` : '';
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "style-src-elem 'self'",
    "style-src-attr 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self'",
    `connect-src 'self'${sockets} wss://*.discordsays.com`,
    "manifest-src 'self'",
    "worker-src 'self'",
    'frame-ancestors https://discord.com https://*.discord.com https://*.discordsays.com',
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
  const headers = {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  };
  // Only over HTTPS: local development runs on plain HTTP.
  if (url.protocol === 'https:') headers['Strict-Transport-Security'] = 'max-age=31536000';
  return headers;
}

// The page origins allowed to open room connections: this site, and the
// Discord Activity's own address, <application id>.discordsays.com.
export function allowedOrigins(url, discordClientId) {
  const out = [url.origin];
  if (typeof discordClientId === 'string' && /^\d+$/.test(discordClientId)) out.push(`https://${discordClientId}.discordsays.com`);
  return out;
}

// A copy of the response with the headers added. Asset responses arrive with
// read-only headers, so a new Response is built around the same body.
export function withHeaders(response, headers) {
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(headers)) out.headers.set(name, value);
  return out;
}
