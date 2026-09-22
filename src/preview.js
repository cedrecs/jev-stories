// Link previews: what Discord, iMessage, Slack and the like show when someone
// pastes a link. index.html carries the tags; here the Worker fills in
// absolute URLs (previews need them) and, for a room link, a card of its own.

import { ratingFromSlug } from './rules.js';

// The preview for a page URL: a room's own card for a room link (old slugs
// included), the game's card for anything else.
export function linkPreview(url) {
  const room = ratingFromSlug(url.pathname.replace(/^\/+|\/+$/g, ''));
  return {
    title: room ? `Join ${room.label}` : null,
    tagline: room ? room.tagline : null,
    url: `${url.origin}/${room ? room.slug : ''}`,
    image: `${url.origin}/icons/og-image.png`,
  };
}

// An HTML page with its preview tags filled in; anything else untouched.
export function withPreview(response, url) {
  if (!(response.headers.get('Content-Type') || '').includes('text/html')) return response;
  const p = linkPreview(url);
  const set = (value) => ({
    element(el) {
      el.setAttribute('content', value);
    },
  });
  let rewriter = new HTMLRewriter()
    .on('meta[property="og:url"]', set(p.url))
    .on('meta[property="og:image"]', set(p.image));
  if (p.title) {
    rewriter = rewriter.on('meta[property="og:title"]', set(p.title)).on('meta[property="og:description"], meta[name="description"]', {
      element(el) {
        el.setAttribute('content', `${p.tagline}. ${el.getAttribute('content')}`);
      },
    });
  }
  return rewriter.transform(response);
}
