// 合併 seeds + data/cache/resolved.json + data/overrides.json → data/anime.json
// 用法：node scripts/build.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseSeeds, ROOT, CACHE_DIR } from './lib.mjs';

const cacheFile = path.join(CACHE_DIR, 'resolved.json');
const cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {};
const ovFile = path.join(ROOT, 'data', 'overrides.json');
const overrides = existsSync(ovFile) ? JSON.parse(readFileSync(ovFile, 'utf8') || '{}') : {};
// 補資料步驟產生的詞曲唱（可選）
const enrichFile = path.join(CACHE_DIR, 'credits.json');
const credits = existsSync(enrichFile) ? JSON.parse(readFileSync(enrichFile, 'utf8')) : {};

const works = parseSeeds();
const out = [];
const missing = [];
let total = 0;

for (const w of works) {
  const workName = w.zh === w.ja ? w.zh : `${w.zh}（${w.ja}）`;
  for (const s of w.songs) {
    total++;
    const r = cache[s.key];
    if (!r || r.fail) { missing.push(`${w.zh} / ${s.kind} ${s.title}`); continue; }
    const ov = overrides[s.id] || {};
    if (ov.disabled) continue;
    const cr = credits[s.key] || {};
    const pick = (a, b) => a || b || undefined;
    out.push({
      id: 'a-' + s.id,
      workId: w.workId,
      kind: s.kind,
      ytId: ov.ytId || r.ytId,
      start: ov.start ?? r.start,
      prompt: s.kind === 'OST' ? '這段配樂來自哪部動畫？' : '這首歌來自哪部動畫？',
      answer: {
        title: s.title,
        work: workName,
        artist: pick(s.artist, cr.artist),
        lyricist: pick(s.lyricist, cr.lyricist),
        composer: pick(s.composer, cr.composer),
        arranger: pick(s.arranger, cr.arranger),
      },
      year: w.year,
      difficulty: s.difficulty,
      // 以下欄位僅供 preview.html 檢查用
      video: r.videoTitle,
      channel: r.channel,
      startSource: r.startSource,
      review: r.review || undefined,
    });
  }
}

writeFileSync(path.join(ROOT, 'data', 'anime.json'), JSON.stringify(out, null, 1));
const nWorks = new Set(out.map((q) => q.workId)).size;
console.log(`seeds 共 ${total} 首 / ${works.length} 部作品`);
console.log(`入庫 ${out.length} 首（${nWorks} 部作品），缺影片 ${missing.length} 首`);
if (missing.length) {
  writeFileSync(path.join(CACHE_DIR, 'missing.txt'), missing.join('\n'));
  console.log('缺影片清單已寫入 data/cache/missing.txt');
}
