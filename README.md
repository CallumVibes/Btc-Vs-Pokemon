# Bitcoin vs Pokémon

Bitcoin against whichever Pokémon card is currently the most expensive on a shortlist of
grails, priced in pounds. No cards to add, nothing to configure.

Bitcoin refreshes every five minutes in the browser while the page is open. Card prices come
from a job that commits one snapshot a day — Cardmarket only revalues cards daily, so a
faster job would fetch the same number and burn through the free API's daily allowance.

## Just want to look at it?

Open `index.html`. With no history committed yet it fetches live prices and shows today's
figures, but it can't show a trend until snapshots start accumulating.

## Running it properly (about five minutes)

1. Create a new **public** repo on GitHub and upload everything in this folder,
   keeping the structure intact.
2. **Settings → Pages** → Source: *Deploy from a branch* → Branch: `main`, folder `/ (root)`.
   Save. Your page appears at `https://<you>.github.io/<repo>/` within a minute or two.
3. **Settings → Actions → General** → scroll to *Workflow permissions* → select
   **Read and write permissions** → Save. Without this the daily job can't commit.
4. **Actions** tab → *Daily price snapshot* → **Run workflow**. This takes the first
   snapshot immediately rather than waiting for tomorrow.
5. Send your friends the link.

## Installing it as an app

Once it's on GitHub Pages it's a full PWA — your friends can add it to their home screen
and it opens fullscreen with no browser chrome, works offline, and keeps its own icon.

- **Android / Chrome**: open the link, then the ⋮ menu → *Add to Home screen* (or accept the
  install prompt if it appears).
- **iPhone / Safari**: open the link, tap Share → *Add to Home Screen*.

Offline, it shows the last prices it saw rather than an error page. Live prices obviously
need a connection — the service worker deliberately never caches them, because a stale
price is worse than no price.

The service worker only registers over https, so opening `index.html` from your files still
works normally; it just isn't installable until it's hosted.

From then on it runs at 07:00 UTC every day on its own. Free, no API keys, no server of
your own. GitHub pauses scheduled jobs on repos with no activity for 60 days — if it goes
quiet, open the Actions tab and hit *Run workflow* to wake it up.

**Don't be tempted to run this job every five minutes.** Five minutes is GitHub's floor for
scheduled workflows, but at that rate you'd make ~288 commits a day, and the keyless Pokémon
TCG API allows roughly 1,000 requests a day — five queries per run would exhaust that before
lunch. The card price wouldn't have changed anyway. Bitcoin already updates every five
minutes client-side, which is where the movement actually is.

## Files

| Path | What it does |
|---|---|
| `index.html` | The page. Reads `data/history.json`, falls back to live fetches. |
| `scripts/update.mjs` | Fetches prices, appends one snapshot. Node 20+, no dependencies. |
| `.github/workflows/daily.yml` | Runs the script daily and commits the result. |
| `data/history.json` | The accumulated snapshots. Starts empty. |
| `manifest.webmanifest` | App name, colours and icons for installing to a home screen. |
| `sw.js` | Service worker. Caches the app shell; never caches price feeds. |
| `icons/` | App icons, including a maskable one for Android. |

## Changing which cards it watches

Edit the `QUERIES` array at the top of `scripts/update.mjs`. Each entry is a
[Pokémon TCG API](https://docs.pokemontcg.io/) search; the priciest match from each is kept,
and the most expensive overall becomes the headline card. The dropdown on the page lets you
switch between them.

## Worth knowing

- Card prices are Cardmarket data for **raw, ungraded** copies. Graded slabs trade far higher,
  and a PSA 10 of the same card is effectively a different asset.
- Card prices move daily but slowly; bitcoin moves constantly. Over short windows that makes
  bitcoin look wilder in both directions.
- One card against one asset over a window you chose is a much narrower claim than
  "Pokémon beats Bitcoin." Change the range and the winner can flip.
- Not investment advice.
