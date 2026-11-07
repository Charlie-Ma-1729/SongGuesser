// 共用：解析 seeds、字串正規化、雜湊
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SEED_DIR = path.join(ROOT, 'data', 'seeds');
export const CACHE_DIR = path.join(ROOT, 'data', 'cache');

export const hash = (s, n = 8) => createHash('sha1').update(s).digest('hex').slice(0, n);

/** 比對用正規化：全形→半形、小寫、只留文字與數字 */
export function norm(s) {
  return String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s　"'`~!@#$%^&*()_+=\[\]{}|\\:;,.<>?/·・「」『』（）【】〈〉《》、。~〜～\-–—]/g, '');
}

const KINDS = ['OP', 'ED', 'INSERT', 'OST'];

/** 解析 data/seeds/*.txt → [{ work, zh, ja, year, workId, songs:[...] }] */
export function parseSeeds() {
  const files = readdirSync(SEED_DIR).filter((f) => f.endsWith('.txt')).sort();
  const works = [];
  const seenWork = new Map();
  let cur = null;
  for (const f of files) {
    const lines = readFileSync(path.join(SEED_DIR, f), 'utf8').split(/\r?\n/);
    lines.forEach((raw, i) => {
      const line = raw.trim();
      if (!line) return;
      const h = line.match(/^#\s+(.+?)\s*\|\s*(\d{4})\s*$/);
      if (h) {
        const work = h[1].trim();
        if (seenWork.has(work)) {
          cur = seenWork.get(work);
        } else {
          const m = work.match(/^(.*?)（(.*)）$/);
          cur = {
            work,
            zh: m ? m[1].trim() : work,
            ja: m ? m[2].trim() : work,
            year: Number(h[2]),
            workId: 'w' + hash(work, 6),
            songs: [],
          };
          works.push(cur);
          seenWork.set(work, cur);
        }
        return;
      }
      if (line.startsWith('#')) return;
      const kind = line.split('|')[0].trim();
      if (!KINDS.includes(kind)) {
        console.warn(`[seeds] ${f}:${i + 1} 無法解析：${line}`);
        return;
      }
      if (!cur) throw new Error(`${f}:${i + 1} 歌曲出現在作品標題之前`);
      const fields = line.split('|').map((x) => x.trim());
      const title = fields[1];
      const rest = fields.slice(2).join(' ');
      // 解析 key=value（q 的值可含空白，直到下一個 key）
      const re = /(?:^|\s)([lcaqdt])=/g;
      const marks = [];
      let m;
      while ((m = re.exec(rest))) marks.push({ key: m[1], idx: m.index, end: re.lastIndex });
      const artistRaw = (marks.length ? rest.slice(0, marks[0].idx) : rest).trim();
      const kv = {};
      marks.forEach((mk, k) => {
        kv[mk.key] = rest.slice(mk.end, k + 1 < marks.length ? marks[k + 1].idx : undefined).trim();
      });
      const artist = artistRaw && artistRaw !== '?' ? artistRaw : null;
      const key = `${cur.work}|${kind}|${title}`;
      cur.songs.push({
        key,
        id: hash(key),
        kind,
        title,
        artist,
        lyricist: kv.l || null,
        composer: kv.c || null,
        arranger: kv.a || null,
        query: kv.q || null,
        alt: kv.t ? kv.t.split('/').map((x) => x.trim()).filter(Boolean) : [],
        difficulty: kv.d ? Number(kv.d) : 1,
      });
    });
  }
  applyCredits(works);
  return works;
}

/** data/seeds/credits.tsv：以歌名補充（只補歌單沒填的欄位） */
function applyCredits(works) {
  const f = path.join(SEED_DIR, 'credits.tsv');
  let text;
  try { text = readFileSync(f, 'utf8'); } catch { return; }
  const map = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const p = line.split('|').map((x) => x.trim());
    const v = (x) => (x && x !== '-' ? x : null);
    map.set(p[0], { l: v(p[1]), c: v(p[2]), a: v(p[3]) });
  }
  for (const w of works) {
    for (const s of w.songs) {
      const cr = map.get(s.title);
      if (!cr) continue;
      s.lyricist = s.lyricist || cr.l;
      s.composer = s.composer || cr.c;
      s.arranger = s.arranger || cr.a;
    }
  }
}

export function allSongs(works) {
  return works.flatMap((w) => w.songs.map((s) => ({ ...s, workObj: w })));
}
