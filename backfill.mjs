// One-off backfill. Pulls REAL historical card prices from TCGCSV's archive of
// TCGplayer's daily data, which goes back to 2024-02-08, and writes them into
// history.json. Free, no API key. Run it manually from the Actions tab.
//
//   node backfill.mjs                 # ~1 year, weekly samples
//   DAYS=730 STEP=14 node backfill.mjs
//
// Needs 7z, which GitHub's ubuntu runners already have.

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);

const CATEGORY = 3;                                   // Pokémon on TCGplayer
const DAYS = parseInt(process.env.DAYS || "365", 10); // how far back
const STEP = parseInt(process.env.STEP || "7", 10);   // sample every N days
const EARLIEST = "2024-02-08";                        // archive starts here
const TMP = ".backfill";
const OUT = "history.json";

const CG = "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=gbp&days=365";
const CG_USD = "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=365";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const iso = d => d.toISOString().slice(0, 10);

async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "btc-vs-pokemon/1.0" } });
      if (r.ok) return await r.json();
      if (r.status === 429) { await sleep(5000 * (i + 1)); continue; }
      throw new Error(`${r.status} on ${url}`);
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(2000 * (i + 1));
    }
  }
}

// Pick the printing most people mean: the holo for vintage, normal otherwise.
const SUBTYPE_ORDER = ["Holofoil", "1st Edition Holofoil", "Unlimited Holofoil",
                       "Reverse Holofoil", "Normal", "1st Edition"];
function pickPrice(rows) {
  for (const st of SUBTYPE_ORDER) {
    const hit = rows.find(r => r.subTypeName === st && r.marketPrice > 0);
    if (hit) return hit.marketPrice;
  }
  const any = rows.find(r => r.marketPrice > 0);
  return any ? any.marketPrice : null;
}

// Match our tracked cards to TCGplayer product ids, via set name and number.
async function mapProducts(cards) {
  console.log("fetching TCGplayer group list…");
  const groups = (await getJson(`https://tcgcsv.com/tcgplayer/${CATEGORY}/groups`)).results || [];
  const norm = s => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

  const mapping = {};
  const wanted = [...new Set(cards.map(c => c.set))].filter(Boolean);

  for (const setName of wanted) {
    const g = groups.find(x => norm(x.name) === norm(setName))
           || groups.find(x => norm(x.name).includes(norm(setName)))
           || groups.find(x => norm(setName).includes(norm(x.name)));
    if (!g) { console.log(`  no TCGplayer group for set "${setName}"`); continue; }

    const products = (await getJson(
      `https://tcgcsv.com/tcgplayer/${CATEGORY}/${g.groupId}/products`)).results || [];
    await sleep(250);

    for (const card of cards.filter(c => c.set === setName)) {
      const num = String(card.number || "").replace(/^0+/, "");
      const hit = products.find(p => {
        const ext = (p.extendedData || []).find(e => e.name === "Number");
        const pn = ext ? String(ext.value).split("/")[0].replace(/^0+/, "") : null;
        return norm(p.name).startsWith(norm(card.name)) && (!num || pn === num);
      }) || products.find(p => norm(p.name) === norm(card.name));

      if (hit) {
        mapping[card.id] = {productId: hit.productId, groupId: g.groupId, name: hit.name};
        console.log(`  ${card.name} (${setName}) -> product ${hit.productId}`);
      } else {
        console.log(`  couldn't match ${card.name} in ${setName}`);
      }
    }
  }
  return mapping;
}

async function pricesForDate(date, groupIds) {
  const url = `https://tcgcsv.com/archive/tcgplayer/prices-${date}.ppmd.7z`;
  const file = `${TMP}/${date}.7z`;

  const res = await fetch(url, { headers: { "User-Agent": "btc-vs-pokemon/1.0" } });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(file, buf);

  // Extract only the Pokémon groups we care about, not the whole archive.
  const args = ["x", file, `-o${TMP}/${date}`, "-y"];
  for (const gid of groupIds) args.push(`${date}/${CATEGORY}/${gid}/prices`);
  try { await run("7z", args, {maxBuffer: 1 << 28}); }
  catch (e) { console.log(`  ${date}: extract failed`); return null; }

  const out = {};
  for (const gid of groupIds) {
    const p = `${TMP}/${date}/${date}/${CATEGORY}/${gid}/prices`;
    if (!existsSync(p)) continue;
    try {
      const j = JSON.parse(await readFile(p, "utf8"));
      for (const row of j.results || []) {
        (out[row.productId] = out[row.productId] || []).push(row);
      }
    } catch (e) { /* skip a malformed group */ }
  }
  await rm(file, {force: true});
  await rm(`${TMP}/${date}`, {recursive: true, force: true});
  return out;
}

async function main() {
  let history = [];
  try { history = JSON.parse(await readFile(OUT, "utf8")); } catch {}
  if (!Array.isArray(history)) history = [];
  if (!history.length) {
    console.error("history.json is empty — run update.mjs once first so we know which cards to track.");
    process.exit(1);
  }

  const latest = history[history.length - 1];
  const cards = Object.entries(latest.cards).map(([id, c]) => ({id, ...c}));
  console.log(`tracking ${cards.length} cards\n`);

  const mapping = await mapProducts(cards);
  const ids = Object.keys(mapping);
  if (!ids.length) { console.error("\nno cards could be matched to TCGplayer products."); process.exit(1); }
  const groupIds = [...new Set(ids.map(id => mapping[id].groupId))];

  console.log("\nfetching bitcoin history…");
  const [gbpChart, usdChart] = await Promise.all([getJson(CG), getJson(CG_USD)]);
  const btcAt = (chart, ts) => {
    let best = null, gap = Infinity;
    for (const p of chart.prices || []) {
      const g = Math.abs(p[0] - ts);
      if (g < gap) { gap = g; best = p; }
    }
    return best ? best[1] : null;
  };

  await mkdir(TMP, {recursive: true});

  const dates = [];
  for (let d = DAYS; d >= 1; d -= STEP) {
    const day = iso(new Date(Date.now() - d * 86400000));
    if (day >= EARLIEST) dates.push(day);
  }
  console.log(`\nfetching ${dates.length} archive days (every ${STEP} days, back ${DAYS})\n`);

  const added = [];
  for (const date of dates) {
    if (history.some(h => h.d === date && !h.est)) { console.log(`  ${date}: already have it`); continue; }
    let rows = null;
    try { rows = await pricesForDate(date, groupIds); }
    catch (e) { console.log(`  ${date}: ${e.message}`); }
    if (!rows) { console.log(`  ${date}: no archive`); continue; }

    const ts = new Date(date + "T12:00:00Z").getTime();
    const gbp = btcAt(gbpChart, ts), usd = btcAt(usdChart, ts);
    if (!gbp || !usd) { console.log(`  ${date}: no bitcoin price`); continue; }

    const cardsOut = {};
    for (const id of ids) {
      const price = pickPrice(rows[mapping[id].productId] || []);
      if (price == null) continue;
      const src = latest.cards[id];
      cardsOut[id] = {name:src.name, set:src.set, number:src.number, year:src.year,
                      img:src.img, usd: price};
    }
    if (!Object.keys(cardsOut).length) { console.log(`  ${date}: no prices matched`); continue; }

    added.push({d: date, btc: {gbp, usd, eur: gbp / (gbp / usd) * (gbp / usd)}, cards: cardsOut, src: "tcgcsv"});
    console.log(`  ${date}: ${Object.keys(cardsOut).length} cards, BTC £${Math.round(gbp)}`);
    await sleep(400);
  }

  // Real archive data replaces anything reconstructed for the same day.
  const byDate = new Map(history.filter(h => !h.est).map(h => [h.d, h]));
  for (const entry of added) byDate.set(entry.d, entry);
  for (const h of history) if (!byDate.has(h.d)) byDate.set(h.d, h);

  const merged = [...byDate.values()].sort((a, b) => (a.d < b.d ? -1 : 1));
  await writeFile(OUT, JSON.stringify(merged, null, 0) + "\n");
  await rm(TMP, {recursive: true, force: true});

  console.log(`\nadded ${added.length} days of real price history. history.json now holds ${merged.length} entries.`);
}

main().catch(e => { console.error(e); process.exit(1); });
