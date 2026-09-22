// Security headers for every response the Worker returns. Static files come
// through the Worker too (run_worker_first in wrangler.toml), so the page,
// the script and the service worker all carry them.
//
// The content security policy allows exactly what the app uses: its own
// files; Google Fonts (the stylesheet and the font files); style attributes,
// which the pie and the progress bars carry their data in; and the room
// WebSocket on this host. Scripts come only from this site, and the page can
// never be framed elsewhere.

export function securityHeaders(url) {
  const host = /^[a-z0-9.:\[\]-]+$/i.test(url.host) ? url.host : '';
  const sockets = host ? ` wss://${host} ws://${host}` : '';
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'",
    "style-src-elem 'self' https://fonts.googleapis.com",
    "style-src-attr 'unsafe-inline'",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self'",
    `connect-src 'self'${sockets}`,
    "manifest-src 'self'",
    "worker-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
  const headers = {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  };
  // Only over HTTPS: local development runs on plain HTTP.
  if (url.protocol === 'https:') headers['Strict-Transport-Security'] = 'max-age=31536000';
  return headers;
}

// A copy of the response with the headers added. Asset responses arrive with
// read-only headers, so a new Response is built around the same body.
export function withHeaders(response, headers) {
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(headers)) out.headers.set(name, value);
  return out;
}
