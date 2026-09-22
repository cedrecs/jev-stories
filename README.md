# Jev Yarn

A party game inspired by Y.A.R.N.: everyone writes the next line of a shared
story, and instead of a vote, **TypeSafe's Jev** picks the winner. Installable
as a PWA, runs on Cloudflare Workers with one Durable Object per room.

Live: https://jev-yarn.jevie.app

## How a game plays

1. Pick an emoji icon, a nickname and one of four rooms. No accounts, no
   room codes. The icon is fixed once you join a room.
2. A room runs whenever two or more people are in it. There is no host.
3. Players take turns as **theme setter**. The setter writes a theme, picks a
   story length (Short 4 to 7 lines, Medium 7 to 12, Long 12 to 18) and can
   tune what Jev rewards with four sliders: Funny, Flows, On theme,
   Surprising. The sliders can be changed every round. If the setter runs out
   of time or leaves, the next player in line takes over.
4. Every round, everyone (setter included) writes one sentence against the
   clock. The round closes when everyone has written or the timer runs out.
   It does not wait for a player whose app is in the background, or for one
   who sat out the last round and has not started typing in this one.
5. Jev reads every candidate and the story so far. The winner is appended to
   the story and its author scores a point.
6. The reveal shows the top five with Jev's share and a per-dimension
   breakdown, and holds for 30 seconds. Players can **tap** the line they
   liked best (never their own), change their mind by tapping another line,
   or clear the pick by tapping it again; only the last pick counts when the
   window closes. Picks never change the outcome; they nudge the room's
   default sliders toward what its players enjoy, and the Scores drawer shows
   how often players agreed with Jev. The setter can skip ahead, or end the
   story right there after confirming; Jev then scores it as usual.
7. Jev also judges whether the story feels finished. Once past its minimum
   length, a winning line that reads like an ending closes the story; the
   maximum length is a hard stop. Jev then scores the finished story out of
   100 on the same four qualities it uses for lines, and the story is shown
   for 30 seconds with Copy, Download and Share.
8. Scores last while you stay. Leaving wipes them; a refresh or a brief drop
   keeps the seat for 60 seconds. The Scores panel shows Jev's judgement
   criteria as a pie chart, then your score, then everyone else's from highest
   to lowest with how long each player has been in the room.
9. When the last person leaves a room, the room resets: the next players start
   a fresh story with a new theme. The room keeps what it has learned from
   players' picks.

## Rooms and moderation

| Room | Link | Jev filters |
| --- | --- | --- |
| Safe for Everyone | `/safe-for-everyone` | any violence beyond slapstick, any sexual reference, any swearing, hate and harassment |
| Moderated for Teens | `/moderated-for-teens` | graphic violence, explicit sexual content, strong profanity, hate and harassment |
| Mature Audience Only | `/mature-audience-only` | pornographic description, hate and harassment |
| Absolute Degenerates | `/absolute-degenerates` | nothing |

Absolute Degenerates has no filters at all. In the other rooms a filtered
line cannot win. Its author sees why; nobody else sees the line, or whose it
was. A line Jev could not check cannot win either. Nicknames and themes go
through the same filters and are refused when they fail. The presets live in
`src/rules.js` (`RATINGS`). Links from before the rooms were renamed,
`/everyone`, `/teen`, `/mature` and `/adult`, still open the same rooms.

## How Jev judges a round

Every round, all requests go to `POST https://api.typesafe.ai/v1/systemone`
in parallel:

- **One taste request**: four Choice questions, one per dimension, over every
  candidate line. Jev returns a probability per line for each dimension.
  Code mixes them with the setter's slider weights into one share per line.
- **Detail requests in chunks of 20 lines**: per line, one Noul ("would the
  story feel finished if this were added?") plus one Noul per room filter.
  A line is filtered when any filter's probability passes 0.5. Past the
  minimum story length the closure probability is blended into the share
  (up to half the weight at the maximum) and decides whether the story ends.

When a story ends, one more request rates the whole story with four Score
questions, one per quality, each on five described levels. The story's slider
weights combine them into Jev's score out of 100.

Candidates are shuffled and labelled A, B, C before judging; Jev never sees
player names. With 100 players a round is 6 requests and Jev answers in well
under a second. See `src/judge.js` and `src/rules.js`; the math is unit
tested in `tests/judge.test.js`.

## Project layout

```
src/index.js         Worker: room list, WebSocket hand-off, static assets
src/room.js          Durable Object: players, phases, timers (alarms), sockets
src/judge.js         TypeSafe request builder, scoring, transport, mock
src/rules.js         Rooms, dimensions, filters, learning rule, validation
src/headers.js       Security headers and the Content-Security-Policy
src/preview.js       Link previews: absolute URLs and a card per room
public/              PWA: index.html, app.js, styles.css, sw.js, manifest, icons, fonts, vendor
assets/              logo-source.png, the master logo every icon and the preview image come from
scripts/             make-icons.mjs (icons), build-discord-sdk.mjs (Discord SDK bundle), load-test.mjs (synthetic players)
tests/               node --test suites
```

## Settings

Settings are fixed per deployment, not per room or host. Defaults: 60 s to
write a line (cap 120), 90 s to set a theme, 30 s reveal, 30 s story-end
screen, 280 characters per line, 100 players per room. Override with `[vars]`
in `wrangler.toml` (see the comments there) and redeploy.

## Discord

The game also runs inside Discord as an Activity, from the App Launcher in a
server channel or group chat. There each call (Activity instance) gets its
own private set of the four rooms; the website keeps its public rooms.
Players type a nickname as they do on the web.

Setup: create an app in the Discord Developer Portal, enable Activities, map
the prefix `/` to the game's host (`jev-yarn.jevie.app`),
allow User and Guild install, and put the app's Application ID in
`DISCORD_CLIENT_ID` in `wrangler.toml`. The ID is public, not a secret. The
Worker then accepts room connections from `<id>.discordsays.com`, and only
Discord may show the game in a frame.

`public/vendor/discord-sdk.js` is Discord's Embedded App SDK bundled with the
packages it uses (`npm run discord-sdk` rebuilds it; the licences sit next to
it). The page loads it only inside Discord. The two fonts are served from
`public/fonts` (SIL Open Font License), because Discord blocks outside font
hosts.

## Terms and privacy

The Terms of Service and the Privacy Policy live at `/terms` and `/privacy`
(`public/terms.html`, `public/privacy.html`) and are linked from the bottom of
the home page. The Discord app's portal points at the same two addresses. If
what the game stores or sends anywhere changes, update the Privacy Policy.

## Limits and headers

Each connection holds one seat, may send messages of up to 8 KB at up to
three a second (bursts of 30), and is closed if it keeps flooding. One network
address may hold 25 connections to a room. Room connections are accepted only
from the site's own pages and its Discord Activity. Every response carries a Content-Security-Policy
and the usual security headers (`src/headers.js`). The room list is cached for
two seconds. A round Jev never answered, after a restart mid-judge, is judged
again after 90 seconds.

## Deploy to Cloudflare

The live game runs on Cloudflare's Workers Paid plan. The free
plan is fine for trying it out, but its daily limits are too tight for busy
rooms: every player action is a Durable Object storage write, the free plan
allows 100,000 writes a day, and once they run out rooms stop saving until the
next day. Workers Paid includes 50 million writes a month with no daily caps.

```
npx wrangler login --browser=false   # prints a link: open it, click Allow
npm run deploy                       # uploads the Worker and the PWA files
npx wrangler secret bulk .dev.vars   # uploads TYPESAFE_API_KEY from the local file
```

`--browser=false` prints the sign-in link instead of launching a browser,
which is more reliable on some Windows setups. `secret bulk` reads the key
from `.dev.vars` so nothing is pasted or echoed.
Re-run `npm run deploy` after code changes; the secret stays.

The live game answers on its own domain, set as a Workers Custom Domain in
`routes` in `wrangler.toml`; Cloudflare makes its DNS record and certificate.
A staging copy lives in the `[env.staging]` section of the same file and
deploys with `npx wrangler deploy --env staging`, to its own workers.dev
address and never to the custom domain.

On the very first deploy the `workers.dev` subdomain is new and its TLS
certificate takes a few minutes to issue. Until then browsers show a
connection error. Nothing is wrong, wait and retry.

## Credits

Inspired by Y.A.R.N., the Gamespy Arcade story game, and the
[r/Y_A_R_N](https://www.reddit.com/r/Y_A_R_N/) community. Judging by
[TypeSafe](https://typesafe.ai)'s Jev.

## License

MIT. See [LICENSE](LICENSE).
