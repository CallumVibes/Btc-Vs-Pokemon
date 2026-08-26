// Fetches today's bitcoin price and the current chase-card prices,
// then appends one snapshot to history.json.
// Runs on Node 20+ (built-in fetch). No dependencies, no API keys.

import { readFile, writeFile } from "node:fs/promises";

const CG = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=gbp,eur,usd";
const TCG = "https://api.pokemontcg.io/v2/cards";
const FIELDS = "id,name,number,images,set,rarity,cardmarket,tcgplayer";
const OUT = "history.json";
const KEEP = 3650; // ~10 years of daily snapshots

// The grail shortlist. Each query returns a handful of cards; we keep the
// priciest from each. Edit this list if you'd rather track different cards.
const QUERIES = [
  // Base Set
  'name:charizard set.id:base1',
  'name:blastoise set.id:base1',
  'name:venusaur set.id:base1',
  'name:pikachu set.id:base1',
  'name:mewtwo set.id:base1',
  // vintage chase
  'name:lugia set.id:neo1',
  'name:umbreon rarity:"Rare Holo Star"',
  // modern chase
  'name:umbreon subtypes:VMAX',
  'name:rayquaza subtypes:VMAX',
  'name:charizard subtypes:VMAX',
  'name:giratina subtypes:VSTAR',
  // promos and oddities
  'name:rayquaza set.id:np',
  'name:pikachu set.id:mcd19'
];

const TOP_N = 16; // how many cards to carry in each snapshot

const today = () => new Date().toISOString().slice(0, 10);

async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "btc-vs-pokemon" } });
      if (r.ok) return await r.json();
      if (r.status === 429) await sleep(4000 * (i + 1));
      else throw new Error(`${r.status} on ${url}`);
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(2000 * (i + 1));
    }
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// TCGplayer market price — the metric TCGCSV's archive records, so backfilled
// history and ongoing snapshots stay directly comparable.
function priceUsd(c) {
  const p = c.tcgplayer && c.tcgplayer.prices;
  if (!p) return null;
  for (const k of ["holofoil","1stEditionHolofoil","unlimitedHolofoil","normal","reverseHolofoil","1stEdition"]) {
    if (p[k] && p[k].market > 0) return p[k].market;
  }
  for (const v of Object.values(p)) if (v && v.market > 0) return v.market;
  return null;
}

function priceEur(c) {
  const p = c.cardmarket && c.cardmarket.prices;
  if (!p) return null;
  return p.trendPrice ?? p.averageSellPrice ?? p.avg30 ?? null;
}

async function main() {
  const btcRaw = await getJson(CG);
  const btc = btcRaw && btcRaw.bitcoin;
  if (!btc || !btc.gbp) throw new Error("no bitcoin price returned");

  const found = new Map();
  for (const q of QUERIES) {
    try {
      const url = `${TCG}?q=${encodeURIComponent(q)}&pageSize=20&select=${FIELDS}`;
      const d = await getJson(url);
      const cards = (d.data || [])
        .map(c => ({
          id: c.id,
          name: c.name,
          set: c.set ? c.set.name : "",
          number: c.number || "",
          year: c.set && c.set.releaseDate ? c.set.releaseDate.slice(0, 4) : "",
          img: (c.images && (c.images.large || c.images.small)) || "",
          eur: priceEur(c),
          usd: priceUsd(c),
          cmp: (c.cardmarket?.prices?.avg1) ?? (c.cardmarket?.prices?.averageSellPrice)
               ?? (c.cardmarket?.prices?.avg7) ?? priceEur(c),
          avg1:  (c.cardmarket?.prices?.avg1)  ?? null,
          avg7:  (c.cardmarket?.prices?.avg7)  ?? null,
          avg30: (c.cardmarket?.prices?.avg30) ?? null
        }))
        .filter(c => c.eur != null)
        .sort((a, b) => b.eur - a.eur);
      if (cards[0]) found.set(cards[0].id, cards[0]);
      await sleep(400); // be polite to the free API
    } catch (e) {
      console.error(`query failed: ${q} — ${e.message}`);
    }
  }

  if (!found.size) throw new Error("no card prices returned");

  const top = [...found.values()].sort((a, b) => b.eur - a.eur).slice(0, TOP_N);

  const snapshot = {
    d: today(),
    btc: { gbp: btc.gbp, eur: btc.eur, usd: btc.usd },
    cards: Object.fromEntries(top.map(c => [c.id, {
      name: c.name, set: c.set, number: c.number, year: c.year, img: c.img,
      eur: c.eur, usd: c.usd, cmp: c.cmp, avg1: c.avg1, avg7: c.avg7, avg30: c.avg30
    }]))
  };

  // First run: reconstruct the last 30 days from Cardmarket's rolling averages
  // and bitcoin's daily closes, so the repo starts with a month of history
  // instead of a single point. Marked est so it's never mistaken for measured.
  async function backfill(history) {
    if (history.length) return history;
    let closes = [];
    try {
      const c = await getJson("https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=gbp&days=30");
      closes = (c && c.prices) || [];
    } catch { return history; }
    if (!closes.length) return history;

    const btcAt = daysAgo => {
      const t = Date.now() - daysAgo * 86400000;
      let best = closes[0], gap = Infinity;
      for (const p of closes) { const g = Math.abs(p[0] - t); if (g < gap) { gap = g; best = p; } }
      return best[1];
    };
    const anchorsFor = c => {
      const pts = [];
      if (c.avg30 > 0) pts.push({t:30, v:c.avg30}, {t:15, v:c.avg30});
      if (c.avg7  > 0) pts.push({t:3.5, v:c.avg7});
      if (c.avg1  > 0) pts.push({t:1, v:c.avg1});
      if (c.eur   > 0) pts.push({t:0, v:c.eur});
      return pts.sort((a, b) => b.t - a.t);
    };
    const valueAt = (pts, d) => {
      if (!pts.length) return null;
      if (d >= pts[0].t) return pts[0].v;
      if (d <= pts.at(-1).t) return pts.at(-1).v;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i+1];
        if (d <= a.t && d >= b.t) {
          const s = a.t - b.t;
          return s === 0 ? b.v : a.v + (b.v - a.v) * ((a.t - d) / s);
        }
      }
      return pts.at(-1).v;
    };

    const anchors = new Map(top.map(c => [c.id, anchorsFor(c)]));
    const scale = btc.gbp / btcAt(0);           // keep FX consistent with today
    const out = [];
    for (let d = 30; d >= 1; d--) {
      const gbp = btcAt(d) * scale;
      const cards = {};
      for (const c of top) {
        const v = valueAt(anchors.get(c.id), d);
        if (v == null) continue;
        cards[c.id] = {name:c.name, set:c.set, number:c.number, year:c.year,
                       img:c.img, eur:v, avg1:c.avg1, avg7:c.avg7, avg30:c.avg30};
      }
      if (!Object.keys(cards).length) continue;
      out.push({
        d: new Date(Date.now() - d * 86400000).toISOString().slice(0, 10),
        btc: {gbp, eur: gbp / (btc.gbp / btc.eur), usd: gbp / (btc.gbp / btc.usd)},
        cards, est: true
      });
    }
    console.log(`backfilled ${out.length} reconstructed days`);
    return out;
  }

  let history = [];
  try {
    history = JSON.parse(await readFile(OUT, "utf8"));
    if (!Array.isArray(history)) history = [];
  } catch { /* first run */ }

  history = await backfill(history);

  const i = history.findIndex(h => h.d === snapshot.d);
  if (i >= 0) history[i] = snapshot; else history.push(snapshot);
  history.sort((a, b) => (a.d < b.d ? -1 : 1));
  if (history.length > KEEP) history = history.slice(-KEEP);

  
  await writeFile(OUT, JSON.stringify(history, null, 0) + "\n");

  const champ = top[0];
  console.log(`${snapshot.d}: BTC £${btc.gbp.toLocaleString()} · top card ${champ.name} (${champ.set}) €${champ.eur} · ${history.length} snapshots`);
}

main().catch(e => { console.error(e); process.exit(1); });
