// 從 MyAnimeList 抓「人氣最高」的動畫與它們的 OP/ED，產生歌單 data/seeds/10-mal.txt
// 用法：node scripts/fetch-mal.mjs [--years 2012-2026] [--works 260] [--pages 40] [--per-work 16]
//  - 季度作品會依 Prequel 關係合併成同一部作品（例如「進擊的巨人」第 1～4 季）
//  - 中文名稱取自 Wikidata（沒有就用英文名）
//  - 已經在其他歌單裡出現過的作品／歌曲不會重複
//  - 抓過的頁面快取在 data/cache/mal.json，可中斷後續跑
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { parseSeeds, norm, ROOT, SEED_DIR, CACHE_DIR } from './lib.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
const [Y0, Y1] = String(opt('--years', '2005-2026')).split('-').map(Number);
const WORKS = Number(opt('--works', 260));
const PAGES = Number(opt('--pages', 40));
const PER_WORK = Number(opt('--per-work', 16));
const EASY_WORKS = Number(opt('--easy', 120)); // 人氣前 N 名難度 1
const MID_WORKS = Number(opt('--mid', 420)); // 到這個名次難度 2，其餘難度 3

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const H = { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.8' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(CACHE_DIR, { recursive: true });
const cacheFile = path.join(CACHE_DIR, 'mal.json');
const cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : { list: {}, pages: {}, zh: {} };
const save = () => writeFileSync(cacheFile, JSON.stringify(cache));

async function get(url) {
  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetch(url, { headers: H, signal: AbortSignal.timeout(30000) });
      if (res.status === 429 || res.status >= 500) throw new Error('HTTP ' + res.status);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.text();
    } catch (e) {
      if (i === 4) throw e;
      await sleep(3000 * (i + 1));
    }
  }
}

const dec = (s) => s
  .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/\s+/g, ' ').trim();

// ---------- 1. 人氣排行 ----------
async function loadPopularity() {
  for (let p = 0; p < PAGES; p++) {
    if (cache.list[`p${p}`]) continue;
    const html = await get(`https://myanimelist.net/topanime.php?type=bypopularity&limit=${p * 50}`);
    const rows = [];
    for (const m of html.matchAll(/<tr class="ranking-list">([\s\S]*?)<\/tr>/g)) {
      const row = m[1];
      const id = row.match(/anime\/(\d+)\//)?.[1];
      const title = dec(row.match(/anime_ranking_h3"><a[^>]*>([^<]*)</)?.[1] || '');
      const info = dec((row.match(/<div class="information[^"]*">([\s\S]*?)<\/div>/)?.[1] || '').replace(/<br\s*\/?>/g, ' | '));
      // "TV (25 eps) | Apr 2013 - Sep 2013 | 3,890,123 members"
      const type = info.match(/^(\w+)/)?.[1];
      const year = Number(info.match(/\b(19|20)\d{2}\b/)?.[0]);
      const members = Number((info.match(/([\d,]+) members/)?.[1] || '0').replace(/,/g, ''));
      if (id) rows.push({ id: Number(id), title, type, year, members });
    }
    cache.list[`p${p}`] = rows;
    save();
    console.log(`人氣排行第 ${p + 1}/${PAGES} 頁：${rows.length} 部`);
    await sleep(1500);
  }
  return Object.values(cache.list).flat();
}

// ---------- 2. 單部作品頁 ----------
async function loadPage(id) {
  if (cache.pages[id]?.v === 4) return cache.pages[id];
  const html = await get(`https://myanimelist.net/anime/${id}`);
  const english = dec(html.match(/title-english[^>]*>([^<]*)/)?.[1] || '');
  const romaji = dec(html.match(/<h1 class="title-name[^>]*><strong>([^<]*)/)?.[1] || '');
  const japanese = dec(html.match(/Japanese:<\/span>\s*([^<]*)/)?.[1] || '');
  const aired = dec(html.match(/Aired:<\/span>\s*([^<]*)/)?.[1] || '');
  const year = Number(aired.match(/\b(19|20)\d{2}\b/)?.[0]) || 0;
  const type = dec(html.match(/Type:<\/span>\s*(?:<a[^>]*>)?([^<]*)/)?.[1] || '');
  const members = Number((html.match(/Members:<\/span>\s*([\d,]+)/)?.[1] || '0').replace(/,/g, ''));
  // 前作（只追 Prequel，才能把各季合併到第一季）
  let prequel = null;
  const rel = html.match(/Prequel:<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/);
  if (rel) prequel = Number(rel[1].match(/anime\/(\d+)\//)?.[1]) || null;
  // 續集／番外篇（用來把同系列各季、劇場版都收進來）
  const sequels = [];
  for (const lab of ['Sequel', 'Side story']) {
    const r2 = html.match(new RegExp(lab + ':</td>\\s*<td[^>]*>([\\s\\S]*?)</td>'));
    if (r2) for (const m of r2[1].matchAll(/anime\/(\d+)\//g)) sequels.push(Number(m[1]));
  }

  const themes = { OP: [], ED: [] };
  for (const [kind, cls] of [['OP', 'opnening'], ['ED', 'ending']]) {
    const i = html.indexOf(`theme-songs js-theme-songs ${cls}`);
    if (i < 0) continue;
    let seg = html.slice(i);
    const end = seg.indexOf('</table>\n    </div>');
    seg = seg.slice(0, end > 0 ? end : 20000);
    // 每一列：<td width="84%"> ... <span class="theme-song-artist">by X</span>；歌名可能有連結、也可能沒有，編號（1:）也可能沒有
    for (const m of seg.matchAll(/<td width="84%">([\s\S]*?)<span class="theme-song-artist">([\s\S]*?)<\/span>/g)) {
      const title = dec(m[1].replace(/<input[^>]*>/g, '').replace(/<span class="theme-song-index">[^<]*<\/span>/, '').replace(/<[^>]+>/g, '')).replace(/^"|"$/g, '');
      const artist = dec(m[2]).replace(/^by\s+/i, '');
      if (title) themes[kind].push({ title, artist });
    }
  }
  const page = { v: 4, id, english, romaji, japanese, year, type, members, prequel, sequels: [...new Set(sequels)], themes };
  cache.pages[id] = page;
  if (Object.keys(cache.pages).length % 10 === 0) save();
  await sleep(1300);
  return page;
}

async function rootOf(id) {
  let cur = await loadPage(id);
  const seen = new Set([id]);
  while (cur.prequel && !seen.has(cur.prequel)) {
    seen.add(cur.prequel);
    cur = await loadPage(cur.prequel);
  }
  return cur;
}

// ---------- 3. Wikidata 中文名 ----------
async function loadZh(ids) {
  const need = ids.filter((i) => !(i in cache.zh));
  for (let k = 0; k < need.length; k += 80) {
    const batch = need.slice(k, k + 80);
    const q = `SELECT ?mal ?l WHERE { VALUES ?mal { ${batch.map((i) => `"${i}"`).join(' ')} } ?i wdt:P4086 ?mal . ?i rdfs:label ?l . FILTER(lang(?l) IN ("zh-tw","zh-hant","zh-hk","zh")) }`;
    try {
      const res = await fetch('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q), {
        headers: { 'user-agent': 'SongGuesser/1.0 (hobby project)', accept: 'application/sparql-results+json' },
        signal: AbortSignal.timeout(60000),
      });
      const j = await res.json();
      const pri = { 'zh-tw': 0, 'zh-hant': 1, 'zh-hk': 2, zh: 3 };
      const best = {};
      for (const b of j.results.bindings) {
        const id = b.mal.value;
        const lang = b.l['xml:lang'];
        if (!(id in best) || pri[lang] < best[id].p) best[id] = { p: pri[lang], l: b.l.value };
      }
      for (const i of batch) cache.zh[i] = best[i]?.l || null;
    } catch (e) {
      console.warn('Wikidata 查詢失敗（略過這批）：', e.message);
    }
    save();
    await sleep(1000);
  }
}

// ---------- 指定要加入的作品（data/seeds/mal-extra.txt：每行一個 MAL 編號或搜尋關鍵字）----------
async function loadExtras() {
  const f = path.join(SEED_DIR, 'mal-extra.list');
  if (!existsSync(f)) return [];
  cache.search = cache.search || {};
  const ids = [];
  for (const raw of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^\d+$/.test(line)) { ids.push(Number(line)); continue; }
    if (!(line in cache.search)) {
      try {
        const res = await fetch('https://myanimelist.net/search/prefix.json?type=anime&keyword=' + encodeURIComponent(line) + '&v=1', { headers: H, signal: AbortSignal.timeout(30000) });
        const j = await res.json();
        const hit = (j.categories?.[0]?.items || [])[0];
        cache.search[line] = hit ? Number(hit.id) : null;
        console.log(`指定作品「${line}」→ ${hit ? hit.id + ' ' + hit.name : '找不到'}`);
      } catch (e) {
        console.warn('搜尋失敗：', line, e.message);
      }
      await sleep(1200);
    }
    if (cache.search[line]) ids.push(cache.search[line]);
  }
  save();
  return ids;
}

// ---------- 主流程 ----------
const popular = await loadPopularity();
const MAX_CANDS = Number(opt('--max-cands', 420)); // 只處理人氣最高的前 N 個條目（各季算一個）
const extraIds = await loadExtras();
let cands = popular
  .filter((a) => a.year >= Y0 && a.year <= Y1 && ['TV', 'Movie', 'OVA', 'ONA'].includes(a.type))
  .sort((a, b) => b.members - a.members)
  .slice(0, MAX_CANDS);
for (const id of extraIds) {
  if (cands.some((c) => c.id === id)) continue;
  const pg = await loadPage(id);
  cands.push({ id, title: pg.romaji, type: pg.type, year: pg.year, members: pg.members || 1 });
}
save();
console.log(`符合年份/類型的作品共 ${cands.length} 部`);

// 以第一季（root）為單位合併
const groups = new Map(); // rootId -> { root, entries:[page...], members }
let n = 0;
for (const a of cands) {
  if (groups.size >= WORKS && !groups.has(a.id)) {
    // 已達上限仍需處理，因為有可能併入既有 root
  }
  const root = await rootOf(a.id);
  const page = await loadPage(a.id);
  let g = groups.get(root.id);
  if (!g) {
    if (groups.size >= WORKS && !extraIds.includes(a.id)) continue;
    g = { root, entries: [], members: 0 };
    groups.set(root.id, g);
  }
  if (!g.entries.some((e) => e.id === page.id)) g.entries.push(page);
  g.members += a.members;
  if (++n % 25 === 0) console.log(`已處理 ${n} / ${cands.length} 部，合併成 ${groups.size} 個作品`);
}
// 沿著 Sequel／Side story 把同系列其他季、劇場版、OVA 全部收進來
for (const g of groups.values()) {
  const seenIds = new Set(g.entries.map((e) => e.id));
  const queue = g.entries.slice();
  while (queue.length && seenIds.size < 40) {
    const cur = queue.shift();
    for (const sid of cur.sequels || []) {
      if (seenIds.has(sid)) continue;
      seenIds.add(sid);
      let pg;
      try { pg = await loadPage(sid); } catch { continue; }
      if (!['TV', 'Movie', 'OVA', 'ONA'].includes(pg.type)) continue;
      g.entries.push(pg);
      queue.push(pg);
    }
  }
}
save();

// 其他季度（排行榜較後面的）也要併進來：對每個已知 root，補上同系列後續季
// （只從已抓到的人氣清單裡找 prequel 鏈指向該 root 的條目，已在上面處理）

const ordered = [...groups.values()].sort((a, b) => b.members - a.members);
await loadZh(ordered.map((g) => String(g.root.id)));

// 已有的歌單：用來避免重複作品／歌曲
const existing = parseSeeds({ exclude: ['10-mal.txt'] });
const workByJa = new Map(existing.map((w) => [norm(w.ja), w]));
const workByZh = new Map(existing.map((w) => [norm(w.zh), w]));


const HEADER = '# 由 scripts/fetch-mal.mjs 自動產生（資料來源：MyAnimeList 人氣排行）。請勿手動編輯，要改請改其他歌單或 overrides。';
const romajiTitle = (t) => {
  const m = t.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
  return m ? { ja: m[2].split(';')[0].trim(), ro: m[1].trim() } : { ja: t.trim(), ro: '' };
};

// 以「日文標題前綴」合併各季／劇場版：例如「進撃の巨人 Season3」併入「進撃の巨人」
const canon = existing.map((w) => ({ key: norm(w.ja), header: w.work, year: w.year, rank: Infinity, songs: [], used: new Set(w.songs.map((s) => norm(s.title))), isNew: false }));
const items = ordered.map((g, rank) => {
  const root = g.root;
  const ja = root.japanese || root.romaji;
  const zh = (cache.zh[String(root.id)] || root.english || root.romaji).replace(/\s*第[一1]季$/, '');
  return { rank, g, ja, zh, year: root.year || g.entries[0].year };
}).sort((a, b) => a.year - b.year || a.rank - b.rank);

for (const it of items) {
  const k = norm(it.ja);
  let c = canon.filter((x) => x.key.length >= 3 && k.startsWith(x.key)).sort((a, b) => b.key.length - a.key.length)[0];
  if (!c) {
    c = { key: k, header: `${it.zh}（${it.ja}）`, year: it.year, rank: it.rank, songs: [], used: new Set(), isNew: true };
    canon.push(c);
  }
  c.rank = Math.min(c.rank, it.rank);
  for (const e of it.g.entries.slice().sort((a, b) => a.year - b.year)) {
    for (const kind of ['OP', 'ED']) {
      for (const t of e.themes[kind]) {
        const { ja: tj, ro } = romajiTitle(t.title);
        const key = norm(tj);
        if (!key || c.used.has(key)) continue;
        c.used.add(key);
        const artist = (t.artist || '?').replace(/\|/g, ' ');
        const alt = ro && norm(ro) !== key ? ` t=${ro.replace(/\|/g, ' ')}` : '';
        c.songs.push({ kind, line: `${kind} | ${tj.replace(/\|/g, ' ')} | ${artist} |${alt} DIFF` });
      }
    }
  }
}

const lines = [HEADER, ''];
let totalSongs = 0;
let totalWorks = 0;
for (const c of canon.filter((x) => x.songs.length).sort((a, b) => a.rank - b.rank)) {
  totalWorks++;
  lines.push(`# ${c.header} | ${c.year}`);
  const d = c.rank < EASY_WORKS ? 1 : c.rank < MID_WORKS ? 2 : 3;
  for (const s of c.songs.slice(0, PER_WORK)) { lines.push(s.line.replace('DIFF', `d=${d}`)); totalSongs++; }
  lines.push('');
}
writeFileSync(path.join(SEED_DIR, '10-mal.txt'), lines.join('\n'));
console.log(`完成：${totalWorks} 部作品 / ${totalSongs} 首歌 → data/seeds/10-mal.txt`);
