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
  'name:charizard set.id:base1',
  'name:blastoise set.id:base1',
  'name:venusaur set.id:base1',
  'name:pikachu set.id:base1',
  'name:lugia set.id:neo1',
  'name:umbreon subtypes:VMAX',
  'name:rayquaza subtypes:VMAX',
  'name:charizard subtypes:VMAX',
  'name:giratina subtypes:VSTAR',
  'name:mewtwo set.id:base1'
];

const TOP_N = 8; // how many cards to carry in each snapshot

const today = () => new Date().toISOString().slice(0, 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
          eur: priceEur(c)
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
      name: c.name, set: c.set, number: c.number, year: c.year, img: c.img, eur: c.eur
    }]))
  };

  let history = [];
  try {
    history = JSON.parse(await readFile(OUT, "utf8"));
    if (!Array.isArray(history)) history = [];
  } catch { /* first run */ }

  const i = history.findIndex(h => h.d === snapshot.d);
  if (i >= 0) history[i] = snapshot; else history.push(snapshot);
  history.sort((a, b) => (a.d < b.d ? -1 : 1));
  if (history.length > KEEP) history = history.slice(-KEEP);

  await writeFile(OUT, JSON.stringify(history, null, 0) + "\n");

  const champ = top[0];
  console.log(`${snapshot.d}: BTC £${btc.gbp.toLocaleString()} · top card ${champ.name} (${champ.set}) €${champ.eur} · ${history.length} snapshots`);
}

main().catch(e => { console.error(e); process.exit(1); });
