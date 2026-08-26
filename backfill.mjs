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
// Set names differ between sources — the Pokémon TCG API says "Base" where
// TCGplayer says "Base Set" — so matching tries progressively looser rules and
// reports what it chose, since a wrong group silently yields no cards.
// The two sources name sets differently, and promos are the worst offenders.
const SET_ALIASES = {
  "base": ["base set"],
  "base set": ["base"],
  "evolving skies": ["swsh07: evolving skies", "evolving skies"],
  "champion's path": ["swsh035: champion's path", "champions path"],
  "crown zenith galarian gallery": ["crown zenith: galarian gallery"],
  "nintendo black star promos": ["nintendo promos", "nintendo black star promos"],
  "pop series 5": ["pop series 5"],
  "mcdonald's collection 2019": ["mcdonald's collection 2019", "mcdonalds collection 2019"]
};

const norm = s => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
// Card names carry suffixes TCGplayer words differently: "Charizard (4)",
// "Rayquaza VMAX (Alternate Full Art)".
const bare = s => norm(String(s).replace(/\(.*?\)/g, ""));

function findGroup(groups, setName) {
  const want = norm(setName);
  const aliases = [setName, ...(SET_ALIASES[setName.toLowerCase()] || [])].map(norm);

  for (const a of aliases) {
    const exact = groups.find(g => norm(g.name) === a);
    if (exact) return exact;
  }
  // Prefer the shortest containing name: "Base Set" over "Base Set 2".
  const contains = groups
    .filter(g => aliases.some(a => norm(g.name).includes(a)))
    .sort((x, y) => x.name.length - y.name.length);
  if (contains.length) return contains[0];

  return groups.find(g => aliases.some(a => a.includes(norm(g.name))));
}

function findProduct(products, card) {
  const num = String(card.number || "").replace(/^0+/, "");
  const name = bare(card.name);

  const numberOf = p => {
    const ext = (p.extendedData || []).find(e => e.name === "Number");
    return ext ? String(ext.value).split("/")[0].replace(/^0+/, "") : null;
  };

  // Best: name and card number agree.
  let hit = products.find(p => bare(p.name) === name && numberOf(p) === num);
  if (hit) return hit;
  // Then: the number alone, which is unique within a set.
  if (num) {
    hit = products.find(p => numberOf(p) === num && bare(p.name).startsWith(name));
    if (hit) return hit;
  }
  // Then: an exact name, preferring the plainest variant.
  const byName = products.filter(p => bare(p.name) === name)
    .sort((x, y) => x.name.length - y.name.length);
  if (byName.length) return byName[0];
  // Last: name prefix.
  const prefix = products.filter(p => bare(p.name).startsWith(name))
    .sort((x, y) => x.name.length - y.name.length);
  return prefix[0] || null;
}

async function mapProducts(cards) {
  console.log("fetching TCGplayer group list…");
  const groups = (await getJson(`https://tcgcsv.com/tcgplayer/${CATEGORY}/groups`)).results || [];
  console.log(`  ${groups.length} Pokémon sets on TCGplayer`);

  const mapping = {};
  const wanted = [...new Set(cards.map(c => c.set))].filter(Boolean);

  for (const setName of wanted) {
    const g = findGroup(groups, setName);
    if (!g) {
      console.log(`\n  no TCGplayer set matched "${setName}"`);
      const near = groups.filter(x => norm(x.name).includes(norm(setName).slice(0, 4)))
        .slice(0, 5).map(x => x.name);
      if (near.length) console.log(`    closest names: ${near.join(", ")}`);
      continue;
    }
    console.log(`\n  "${setName}" -> TCGplayer set "${g.name}" (group ${g.groupId})`);

    let products = [];
    try {
      products = (await getJson(
        `https://tcgcsv.com/tcgplayer/${CATEGORY}/${g.groupId}/products`)).results || [];
    } catch (e) {
      console.log(`    couldn't load products: ${e.message}`);
      continue;
    }
    console.log(`    ${products.length} products in that set`);
    await sleep(250);

    for (const card of cards.filter(c => c.set === setName)) {
      const hit = findProduct(products, card);
      if (hit) {
        mapping[card.id] = {productId: hit.productId, groupId: g.groupId, name: hit.name};
        console.log(`    ${card.name} #${card.number} -> ${hit.name} (${hit.productId})`);
      } else {
        console.log(`    NO MATCH for ${card.name} #${card.number}`);
        const near = products.filter(p => bare(p.name).includes(bare(card.name).slice(0, 5)))
          .slice(0, 4).map(p => p.name);
        if (near.length) console.log(`      candidates were: ${near.join(" | ")}`);
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

  const FORCE = process.env.FORCE === "1";
  const byDate = new Map(history.map(h => [h.d, h]));

  const added = [];
  let filled = 0;
  for (const date of dates) {
    // Skip only when this date already holds every card we're mapping. A date
    // saved on an earlier run with fewer cards still needs the rest filling in.
    const have = byDate.get(date);
    if (!FORCE && have && !have.est && ids.every(id => have.cards && have.cards[id])) {
      console.log(`  ${date}: complete`);
      continue;
    }
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

    // Merge into an existing entry rather than replacing it, so cards saved on
    // a previous run survive.
    const prev = (have && !have.est) ? have.cards : {};
    const entry = {d: date, btc: {gbp, usd}, cards: {...prev, ...cardsOut}, src: "tcgcsv"};
    byDate.set(date, entry);

    const isNew = !have || have.est;
    if (isNew) added.push(entry); else filled++;
    console.log(`  ${date}: ${Object.keys(cardsOut).length} cards${isNew ? "" : " (topped up)"}, BTC £${Math.round(gbp)}`);
    await sleep(400);
  }

  const merged = [...byDate.values()].sort((a, b) => (a.d < b.d ? -1 : 1));
  await writeFile(OUT, JSON.stringify(merged, null, 0) + "\n");
  await rm(TMP, {recursive: true, force: true});

  console.log(`\nadded ${added.length} new days, topped up ${filled} existing ones. history.json now holds ${merged.length} entries.`);
}

main().catch(e => { console.error(e); process.exit(1); });
