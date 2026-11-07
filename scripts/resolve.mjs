// 自動為每首歌找 YouTube 影片並驗證可嵌入。
// 用法：node scripts/resolve.mjs [--force] [--retry-failed] [--limit N] [--only 關鍵字]
//  - 結果寫入 data/cache/resolved.json（下次只處理沒處理過的）
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseSeeds, allSongs, norm, CACHE_DIR } from './lib.mjs';

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const RETRY = args.includes('--retry-failed');
const REDO_WEAK = args.includes('--redo-weak');
const LIMIT = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HEADERS = { 'user-agent': UA, 'accept-language': 'ja,zh-TW;q=0.8,en;q=0.6', cookie: 'CONSENT=YES+1' };

const BAD = /cover|カバー|歌ってみた|弾いてみた|piano|ピアノ|オルゴール|music ?box|karaoke|カラオケ|nightcore|reaction|リアクション|8d|slowed|reverb|remix|mashup|instrumental|off ?vocal|オフボーカル|tutorial|解説|ranking|medley|メドレー|loop|hours?|時間|amv|ギター|guitar|drum|ドラム|叩いてみた|tabs|cosplay|踊ってみた|dance|vocaloid|ボカロ|fanmade|fan made|english ver|eng ver|ver\.?\s*en|アレンジ|arrange|8bit|8-bit|chiptune|うたつなぎ|respect|tribute|トリビュート|リメイク|remake|フルコーラス歌ってみた|生演奏|演奏してみた|オーケストラ|orchestra|vocal cover|歌手|歌い手|inst|カラオケ|mv風|ミュージックビデオ風/i;
const LIVE = /live|ライブ|concert|コンサート|fes|festival|フェス|tour|ツアー|acoustic|アコースティック|session|ピアノ/i;
// 不是「純音樂」的影片：預告、談話、劇情、集數、解說…… 開頭可能是對白而不是音樂
const NOT_MUSIC = /予告|trailer|ティザー|teaser|\bpv\b|\bcm\b|スポット|トーク|talk|対談|インタビュー|interview|ラジオ|radio|実況|解説|メイキング|making|ドラマ|ショートフィルム|short ?film|コメント|舞台挨拶|特番|ダイジェスト|digest|名シーン|考察|紹介|解禁|告知|本編|第\s?\d+\s?話|episode|\bep\.?\s?\d+|#\d+|一挙|ハイライト|highlight|ノーカット|cut ver|カット|エピソード|あらすじ|感想|レビュー|review/i;
// 一開始就是音樂的影片類型：歌詞版、ノンクレジット映像、官方音源、Topic 頻道
const AUDIO_FIRST = /ノンクレ|non-?credit|クレジットなし|ノンテロップ|歌詞|lyric|audio|フル|full|op映像|ed映像|オープニング|エンディング|opening|ending/i;
const MV_LIKE = /\bmv\b|music ?video|ミュージックビデオ|short ver|ショートver/i;
// 現場版、演唱會、帶日期的場次、生日派對、樂團/管弦翻奏：一律不要（開頭常有 MC 談話或觀眾聲）
const LIVE_HARD = /\b(19|20)\d{2}[.\/-]\d{1,2}[.\/-]\d{1,2}\b|台北|taipei|台湾|from .*(party|live|tour|concert)|birthday|周年|anniversary live|ライブ映像|live ?ver|ライブ ?ver|\blive\b|ライブ|concert|コンサート|brass|オルケスター|ブラス|吹奏楽|演奏|バンドで|粗品|流田|fes\b|弦オケ|オケ|オーケストラ|strings|draft|編曲[)）]|大学|研究会|サークル|吹奏|アンサンブル|ensemble|quartet|カルテット/i;
const OFFICIAL_CH = /official|公式|topic|lantis|aniplex|king ?records|sony ?music|avex|victor|warner|universal|pony ?canyon|toho|kadokawa|bandai|flying ?dog|columbia|nippon|テレビ|東宝|スタジオジブリ|ジブリ|tv ?asahi|テレ朝|テレビ朝日|avex|epic|toy'?s|ミュージック|music|records|レコード/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseLen(t) {
  if (!t) return 0;
  const p = t.split(':').map(Number);
  return p.reduce((a, b) => a * 60 + b, 0);
}
function parseViews(t) {
  if (!t) return 0;
  const s = t.replace(/,/g, '');
  const n = parseFloat(s.match(/[\d.]+/)?.[0] || '0');
  if (/億/.test(s)) return n * 1e8;
  if (/万/.test(s)) return n * 1e4;
  if (/千/.test(s)) return n * 1e3;
  if (/[Mm]/.test(s)) return n * 1e6;
  if (/[Kk]/.test(s)) return n * 1e3;
  if (/[Bb]/.test(s)) return n * 1e9;
  return n;
}

async function search(q) {
  const url = 'https://www.youtube.com/results?hl=ja&gl=JP&search_query=' + encodeURIComponent(q);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const html = await res.text();
      const m = html.match(/ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s);
      if (!m) throw new Error('找不到 ytInitialData');
      const data = JSON.parse(m[1]);
      const out = [];
      const walk = (o) => {
        if (!o || typeof o !== 'object') return;
        if (o.videoRenderer) {
          const v = o.videoRenderer;
          out.push({
            id: v.videoId,
            title: (v.title?.runs || []).map((r) => r.text).join(''),
            len: parseLen(v.lengthText?.simpleText),
            channel: (v.ownerText?.runs || []).map((r) => r.text).join(''),
            views: parseViews(v.viewCountText?.simpleText),
          });
          return;
        }
        for (const k in o) walk(o[k]);
      };
      walk(data);
      return out;
    } catch (e) {
      if (attempt === 2) throw e;
      await sleep(1500 * (attempt + 1));
    }
  }
}

async function oembed(id) {
  const res = await fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id), { headers: HEADERS });
  if (res.status !== 200) return { ok: false, status: res.status };
  const j = await res.json();
  return { ok: true, title: j.title, author: j.author_name };
}

/** 歌名主體：去掉括號/副標題 */
function coreTitle(t) {
  return t.replace(/[（(].*?[）)]/g, '').replace(/\s*[~〜～].*$/, '').replace(/\s*-.*-\s*$/, '').trim() || t;
}

function artistTokens(a) {
  if (!a) return [];
  return a
    .split(/[\/×&、,・\s]+|feat\.?|inspi'/i)
    .map(norm)
    .filter((x) => x.length >= 2);
}

function score(c, song) {
  const w = song.workObj;
  const vt = norm(c.title);
  const ch = norm(c.channel);
  const core = norm(coreTitle(song.title));
  const titleMatch = core.length > 0 && (vt.includes(core) || vt.includes(norm(song.title)) ||
    (song.alt || []).some((a) => norm(a).length > 0 && vt.includes(norm(a))));
  const toks = artistTokens(song.artist);
  const artistMatch = toks.some((t) => vt.includes(t) || ch.includes(t));
  const workMatch = [w.zh, w.ja].map(norm).some((x) => x.length >= 2 && vt.includes(x));
  const official = OFFICIAL_CH.test(c.channel);
  let s = 0;
  if (titleMatch) s += 6;
  if (artistMatch) s += 4;
  if (workMatch) s += 2;
  const chArtist = toks.some((t) => ch.includes(t));
  if (official) s += 4;
  if (chArtist) s += 6;
  if (/- topic$/i.test(c.channel)) s += 1;
  // 【某某】開頭但不是官方標記 → 很可能是翻唱/二創（例如 VTuber）
  const br = c.title.match(/^[【\[]([^】\]]{1,20})[】\]]/);
  if (br && !/mv|歌詞|lyric|公式|official|フル|full|アニメ|tv|op|ed|期間限定|映像|主題歌|挿入歌|ノンクレ|クレジットなし|ver|版/i.test(br[1])) s -= 8;
  // 判斷「翻奏/現場/談話」前，先把歌名本身與作品名裡的字拿掉
  // （例如歌名 Sleep Walking Orchestra 含 orchestra、デート・ア・ライブ 含 ライブ，不是翻奏或現場）
  const strip = (str) => {
    let x = str;
    for (const t of [song.title, coreTitle(song.title), ...(song.alt || []), w.zh, w.ja]) {
      if (t && t.length >= 2) x = x.split(t).join(' ');
    }
    return x.replace(/love ?live!?|ラブライブ[!！]?(サンシャイン)?|デート[・･]?ア[・･]?ライブ|date a live|アライブ/gi, ' ');
  };
  const ct = strip(c.title);
  const cc = strip(c.channel);
  if (NOT_MUSIC.test(ct)) s -= 30;
  const topic = /- topic$/i.test(c.channel);
  const audioFirst = topic || AUDIO_FIRST.test(ct);
  if (audioFirst) s += 3;
  if (MV_LIKE.test(ct) && !audioFirst) s -= 2;
  if (BAD.test(ct) || BAD.test(cc)) s -= 20;
  if (LIVE_HARD.test(ct) || LIVE_HARD.test(cc)) s -= 30;
  if (LIVE.test(ct)) s -= 4;
  const max = song.kind === 'OST' ? 720 : 420;
  if (c.len < 45 || c.len > max) s -= 20;
  if (c.len > 330 && song.kind !== 'OST') s -= 1;
  s += Math.min(2, Math.log10(Math.max(1, c.views)) / 4);
  const ok = titleMatch && (artistMatch || workMatch || official);
  return { s, ok, titleMatch, artistMatch, workMatch, strong: official || chArtist, audioFirst };
}

/** 讀 watch 頁：取得「最多重播」峰值（毫秒）與實際長度。峰值一定落在音樂裡，用來決定起點。 */
async function watchInfo(id) {
  try {
    const res = await fetch('https://www.youtube.com/watch?hl=ja&v=' + id, { headers: HEADERS });
    if (!res.ok) return {};
    const html = await res.text();
    const len = Number(html.match(/"lengthSeconds":"(\d+)"/)?.[1] || 0) || undefined;
    const m = html.match(/ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s);
    let peak;
    if (m) {
      const marks = [];
      const walk = (o) => {
        if (!o || typeof o !== 'object') return;
        if ('intensityScoreNormalized' in o && 'startMillis' in o) marks.push({ s: +o.startMillis, v: +o.intensityScoreNormalized });
        if ('heatMarkerIntensityScoreNormalized' in o) marks.push({ s: +o.timeRangeStartMillis, v: +o.heatMarkerIntensityScoreNormalized });
        for (const k in o) walk(o[k]);
      };
      walk(JSON.parse(m[1]));
      if (marks.length) peak = marks.sort((a, b) => b.v - a.v)[0].s;
    }
    return { len, peak };
  } catch {
    return {};
  }
}

/**
 * 決定起點（秒）：
 *  1. 有「最多重播」峰值且不在開頭附近 → 取峰值前 4 秒（一定是音樂、通常是副歌）
 *  2. 否則用保守估計：TV size（≤120 秒）從 12 秒起；完整曲約在 20% 位置
 *  最後確保起點後面至少還有 30 秒（設定畫面最長 30 秒）
 */
function pickStart(len, kind, peakMs) {
  let start;
  let source = 'heuristic';
  if (peakMs != null && peakMs >= 8000) {
    start = Math.max(0, Math.floor(peakMs / 1000) - 4);
    source = 'peak';
  } else if (kind === 'OST') start = Math.min(40, Math.max(5, Math.round(len * 0.12)));
  else if (len <= 120) start = 12;
  else start = Math.min(75, Math.max(25, Math.round(len * 0.2)));
  if (start + 30 > len) start = Math.max(0, len - 30);
  return { start, source };
}

function buildQuery(song) {
  if (song.query) return song.query;
  const w = song.workObj;
  const parts = [song.title];
  if (song.artist) parts.push(song.artist);
  if (!song.artist || song.kind === 'OST') parts.push(w.ja);
  return parts.join(' ');
}

async function resolveOne(song) {
  const queries = [buildQuery(song)];
  if (!song.query) queries.push(`${song.title} ${song.workObj.ja} ${song.kind === 'OST' ? 'OST' : song.kind}`);
  const tried = [];
  const seen = new Set();
  for (const q of queries) {
    let results;
    try {
      results = await search(q);
    } catch (e) {
      tried.push({ q, error: String(e.message || e) });
      continue;
    }
    if (process.env.DEBUG) {
      console.log(`\n[DEBUG] q=${q}`);
      for (const c of results.slice(0, 10)) {
        const r = score(c, song);
        console.log(`  ${r.ok ? 'OK ' : '-- '} ${r.s.toFixed(1).padStart(5)} ${c.len}s [${c.channel.slice(0, 18)}] ${c.title.slice(0, 70)}`);
      }
    }
    const ranked = results
      .filter((c) => !seen.has(c.id))
      .map((c) => ({ c, ...score(c, song) }))
      .filter((x) => x.ok && x.s > 4)
      .sort((a, b) => b.s - a.s)
      .slice(0, 4);
    for (const { c, s, strong, audioFirst } of ranked) {
      seen.add(c.id);
      await sleep(150);
      let o;
      try {
        o = await oembed(c.id);
      } catch (e) {
        tried.push({ id: c.id, title: c.title, error: String(e.message || e) });
        continue;
      }
      if (!o.ok) {
        tried.push({ id: c.id, title: c.title, oembed: o.status });
        continue;
      }
      const info = await watchInfo(c.id);
      const len = info.len || c.len;
      const { start, source } = pickStart(len, song.kind, info.peak);
      return {
        ytId: c.id,
        videoTitle: o.title,
        channel: o.author,
        length: len,
        start,
        startSource: source,
        audioFirst: !!audioFirst,
        // 需要人工確認：沒有重播峰值、而且不是「純音樂型」影片（開頭可能有劇情/對白）
        review: source !== 'peak' && !audioFirst,
        score: Math.round(s * 10) / 10,
        official: !!strong,
        resolvedAt: new Date().toISOString().slice(0, 10),
      };
    }
    await sleep(300);
  }
  return { fail: true, tried: tried.slice(0, 6), resolvedAt: new Date().toISOString().slice(0, 10) };
}

async function main() {
  mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, 'resolved.json');
  const cache = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  let songs = allSongs(parseSeeds());
  if (ONLY) songs = songs.filter((s) => s.key.includes(ONLY));
  const todo = songs.filter((s) => FORCE || !cache[s.key] || (RETRY && cache[s.key].fail) || (REDO_WEAK && !cache[s.key].fail && !cache[s.key].official)).slice(0, LIMIT);
  console.log(`共 ${songs.length} 首，待處理 ${todo.length} 首`);

  let done = 0;
  let okCount = 0;
  const CONC = 3;
  let idx = 0;
  const worker = async () => {
    while (idx < todo.length) {
      const song = todo[idx++];
      let r = await resolveOne(song);
      const prev = cache[song.key];
      if (REDO_WEAK && prev && !prev.fail && (r.fail || !r.official)) r = { ...prev, official: false, checked: true };
      cache[song.key] = r;
      done++;
      if (!r.fail) okCount++;
      const tag = r.fail ? '✗ 失敗' : `✓ ${r.ytId} ${r.videoTitle.slice(0, 40)}`;
      console.log(`[${done}/${todo.length}] ${song.workObj.zh} / ${song.title} → ${tag}`);
      if (done % 10 === 0) writeFileSync(file, JSON.stringify(cache, null, 1));
      await sleep(250);
    }
  };
  await Promise.all(Array.from({ length: CONC }, worker));
  writeFileSync(file, JSON.stringify(cache, null, 1));
  console.log(`完成：成功 ${okCount} / ${todo.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
