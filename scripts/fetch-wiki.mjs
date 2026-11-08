// 從日文維基百科補歌：插入歌／劇中歌，以及 MyAnimeList 漏掉的 OP/ED，順便取得作詞作曲。
// 用法：node scripts/fetch-wiki.mjs [--only 關鍵字] [--limit N]
//  - 對歌單裡每一部作品：搜尋日文維基百科的動畫條目 → 讀「主題歌／挿入歌／劇中歌」段落
//  - 只抽出格式規整的條目：「歌名」＋ 下一行「○○による…オープニングテーマ／エンディングテーマ／挿入歌／劇中歌」
//  - 已經在歌單裡的歌不會重複；結果寫到 data/seeds/11-wiki.txt（可重複執行，快取在 data/cache/wiki.json）
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseSeeds, norm, SEED_DIR, CACHE_DIR } from './lib.mjs';

const args = process.argv.slice(2);
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const LIMIT = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = { 'user-agent': 'SongGuesser/1.0 (hobby project; personal use)' };

const cacheFile = path.join(CACHE_DIR, 'wiki.json');
const cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {};
const save = () => writeFileSync(cacheFile, JSON.stringify(cache));

async function api(params) {
  const url = 'https://ja.wikipedia.org/w/api.php?format=json&' + new URLSearchParams(params);
  for (let i = 0; i < 6; i++) {
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      if (i === 5) throw e;
      await sleep(8000 * (i + 1));
    }
  }
}

/** 找這部作品的維基頁面，回傳純文字 */
async function pageText(ja) {
  const ok = (page, text) => {
    const head = norm(page.title + text.slice(0, 400));
    return head.includes(norm(ja).slice(0, 8)) && /^=+\s*(主題歌|音楽|楽曲|挿入歌|劇中歌)/m.test(text);
  };
  // 1. 先直接試常見的條目標題
  for (const t of [`${ja} (アニメ)`, `${ja} (テレビアニメ)`, ja]) {
    const p = await api({ action: 'query', prop: 'extracts', explaintext: '1', redirects: '1', titles: t });
    const page = Object.values(p.query.pages)[0];
    if (page.missing !== undefined) continue;
    const text = page.extract || '';
    if (ok(page, text)) return { title: page.title, text };
    await sleep(200);
  }
  // 2. 再用搜尋
  const s = await api({ action: 'query', list: 'search', srsearch: `${ja} アニメ`, srlimit: '3' });
  for (const hit of s.query?.search || []) {
    const p = await api({ action: 'query', prop: 'extracts', explaintext: '1', redirects: '1', pageids: String(hit.pageid) });
    const page = Object.values(p.query.pages)[0];
    const text = page.extract || '';
    if (ok(page, text)) return { title: page.title, text };
    await sleep(300);
  }
  return null;
}

const KIND = [
  [/オープニング/, 'OP'],
  [/エンディング/, 'ED'],
  [/挿入歌|劇中歌|イメージソング|インサート/, 'INSERT'],
];

/** 規整格式的歌曲條目 */
function parseSongs(text) {
  const out = [];
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  let inSection = false;
  let curKind = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^=+\s*/.test(l)) {
      curKind = null;
      inSection = /主題歌|音楽|楽曲|挿入歌|劇中歌/.test(l) ||
        (inSection && /^=== /.test(l) && !/^== /.test(l)); // 子標題（第1期等）沿用上層
      if (/^== /.test(l) && !/主題歌|音楽|楽曲|挿入歌|劇中歌/.test(l)) inSection = false;
      continue;
    }
    if (!inSection) continue;
    // 格式 B：「分類標題」下面列「歌名」（話數）＋「作詞 - … / 作曲 - … / 歌 - …」
    const hk = l.match(/^(オープニング|エンディング)テーマ\s*$/) || l.match(/^(挿入歌|挿入曲|劇中歌|イメージソング)\s*$/);
    if (hk) { curKind = /オープニング/.test(hk[1]) ? 'OP' : /エンディング/.test(hk[1]) ? 'ED' : 'INSERT'; continue; }
    const inl = l.match(/^(挿入歌|挿入曲|劇中歌|イメージソング)「(.{1,60}?)」/);
    const bm = inl || l.match(/^「(.{1,60}?)」(?:（[^）]*）)?\s*$/);
    if (bm) {
      const title = inl ? inl[2] : bm[1];
      const kindB = inl ? 'INSERT' : curKind;
      const credit2 = (lines[i + 1] || '').match(/歌\s*[-－－]\s*([^/／]+)/) ? lines[i + 1] : (lines[i + 2] || '');
      const sing = credit2.match(/歌\s*[-－]\s*([^/／]+)/);
      if (kindB && sing) {
        const who = sing[1].replace(/[［\[（(].*$/, '').trim();
        const g = (re) => credit2.match(re)?.[1]?.replace(/[［\[（(].*$/, '').trim();
        const lyr = g(/作詞(?:・作曲)?(?:・編曲)?\s*[-－]\s*([^/／]+)/);
        const cmp = g(/作詞・作曲(?:・編曲)?\s*[-－]\s*([^/／]+)/) || g(/作曲(?:・編曲)?\s*[-－]\s*([^/／]+)/);
        const tmB = title.trim().match(/^(.+?)[（(]([^）)]+)[）)]$/);
        if (!out.some((o) => o.title === (tmB ? tmB[1] : title.trim()))) {
          out.push({ kind: kindB, title: tmB ? tmB[1].trim() : title.trim(), alt: tmB ? tmB[2].trim() : '', artist: who && who.length <= 40 ? who : '?', l: lyr, c: cmp });
        }
      }
    }
    const m = l.match(/^「(.{1,60}?)」\s*$/);
    if (!m) continue;
    const desc = lines[i + 1] || '';
    const d = desc.match(/^(.{1,80}?)による[^。]*?(オープニング|エンディング|挿入歌|劇中歌|イメージソング)/);
    if (!d) continue;
    const kind = KIND.find(([re]) => re.test(d[2]))[1];
    let artist = d[1].split('（')[0].replace(/の歌唱$/, '').replace(/^.*(アニメ|テレビ)/, '').trim();
    if (!artist || artist.length > 40) artist = '?';
    const credit = (re) => desc.match(re)?.[1]?.split(/[、，。]/)[0].trim();
    const both = credit(/作詞・作曲(?:・編曲)?は([^。]+)/);
    const l_ = both || credit(/作詞は([^。]+)/);
    const c_ = both || credit(/作曲は([^。]+)/);
    const tm = m[1].trim().match(/^(.+?)[（(]([^）)]+)[）)]$/);
    out.push({ kind, title: tm ? tm[1].trim() : m[1].trim(), alt: tm ? tm[2].trim() : '', artist, l: l_, c: c_ });
  }
  return out;
}

const works = parseSeeds({ exclude: ['11-wiki.txt'] });
const known = new Set(works.flatMap((w) => w.songs.map((s) => norm(s.title))));
let todo = works.filter((w) => !ONLY || w.work.includes(ONLY));
todo = todo.slice(0, LIMIT);
console.log(`處理 ${todo.length} 部作品`);

let n = 0;
const lines = ['# 由 scripts/fetch-wiki.mjs 自動產生（資料來源：日文維基百科）。請勿手動編輯。', ''];
let added = 0;
for (const w of todo) {
  n++;
  if (!(w.ja in cache) || (cache[w.ja] && cache[w.ja].v !== 2)) {
    try {
      const r = await pageText(w.ja);
      cache[w.ja] = r ? { v: 2, title: r.title, songs: parseSongs(r.text) } : null;
    } catch (e) {
      console.warn('失敗：', w.ja, e.message);
      continue;
    }
    await sleep(900);
    if (n % 20 === 0) { save(); console.log(`${n}/${todo.length}`); }
  }
  const c = cache[w.ja];
  if (!c) continue;
  const mine = [];
  for (const s of c.songs) {
    const key = norm(s.title);
    if (!key || known.has(key)) continue;
    known.add(key);
    const kv = [s.l ? `l=${s.l}` : '', s.c ? `c=${s.c}` : '', s.alt ? `t=${s.alt}` : ''].filter(Boolean).join(' ');
    mine.push(`${s.kind} | ${s.title.replace(/\|/g, ' ')} | ${s.artist.replace(/\|/g, ' ')} | ${kv} d=${w.songs[0]?.difficulty >= 3 ? 3 : w.songs[0]?.difficulty || 1}`);
  }
  if (mine.length) {
    lines.push(`# ${w.work} | ${w.year}`, ...mine, '');
    added += mine.length;
  }
}
save();
writeFileSync(path.join(SEED_DIR, '11-wiki.txt'), lines.join('\n'));
console.log(`完成：新增 ${added} 首 → data/seeds/11-wiki.txt`);
