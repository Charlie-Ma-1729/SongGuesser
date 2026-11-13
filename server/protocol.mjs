// 訊息驗證、設定夾限、暱稱處理
import { SCORE_MODES } from '../js/scoring.js';
import { CATEGORIES } from '../js/questions.js';

export const MAX_PLAYERS = 20;
export const MAX_SCREENS = 3;
export const KINDS = ['OP', 'ED', 'INSERT', 'OST', 'SONG'];

export const DEFAULT_SETTINGS = {
  categories: ['anime'],
  kinds: ['OP', 'ED', 'INSERT', 'OST'],
  count: 10,
  duration: 15,
  difficulty: 2,
  perWork: 99,
  fromMiddle: false,
  answerMode: 'choice', // choice 8 選 1 | typing 打字搜尋
  playMode: 'own', // own 各自播放 | screen 主畫面播放
  quorumMode: 'half', // off | half 過半 | all 全員 | n 指定人數
  quorumN: 2,
  quorumSecs: 10,
  graceSecs: 5, // 音樂播完後的作答寬限
  scoreMode: 'speed',
  penalty: false,
  autoNext: 0, // 揭曉後幾秒自動下一題，0 = 房主手動
  allowLateJoin: true,
};

const num = (v, lo, hi, d) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
};
const oneOf = (v, list, d) => (list.includes(v) ? v : d);
const subset = (v, list, d) => {
  if (!Array.isArray(v)) return d;
  const out = [...new Set(v.filter((x) => list.includes(x)))];
  return out.length ? out : d;
};

/** 把使用者傳來的設定夾成合法值（缺的欄位沿用 prev） */
export function cleanSettings(input, prev = DEFAULT_SETTINGS) {
  const s = input && typeof input === 'object' ? input : {};
  const p = prev;
  return {
    categories: subset(s.categories ?? p.categories, CATEGORIES.map((c) => c.id), p.categories),
    kinds: subset(s.kinds ?? p.kinds, KINDS, p.kinds),
    count: num(s.count ?? p.count, 3, 100, p.count),
    duration: num(s.duration ?? p.duration, 5, 60, p.duration),
    difficulty: num(s.difficulty ?? p.difficulty, 1, 3, p.difficulty),
    perWork: num(s.perWork ?? p.perWork, 1, 99, p.perWork),
    fromMiddle: s.fromMiddle === undefined ? p.fromMiddle : !!s.fromMiddle,
    answerMode: oneOf(s.answerMode ?? p.answerMode, ['choice', 'typing'], p.answerMode),
    playMode: oneOf(s.playMode ?? p.playMode, ['own', 'screen'], p.playMode),
    quorumMode: oneOf(s.quorumMode ?? p.quorumMode, ['off', 'half', 'all', 'n'], p.quorumMode),
    quorumN: num(s.quorumN ?? p.quorumN, 1, MAX_PLAYERS, p.quorumN),
    quorumSecs: num(s.quorumSecs ?? p.quorumSecs, 3, 60, p.quorumSecs),
    graceSecs: num(s.graceSecs ?? p.graceSecs, 0, 30, p.graceSecs),
    scoreMode: oneOf(s.scoreMode ?? p.scoreMode, SCORE_MODES, p.scoreMode),
    penalty: s.penalty === undefined ? p.penalty : !!s.penalty,
    autoNext: s.autoNext === undefined ? p.autoNext : (num(s.autoNext, 0, 60, 0) === 0 ? 0 : num(s.autoNext, 3, 60, 10)),
    allowLateJoin: s.allowLateJoin === undefined ? p.allowLateJoin : !!s.allowLateJoin,
  };
}

/** 暱稱：去頭尾空白與控制字元、最長 12 字；空的回傳 null */
export function cleanNick(v) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
  return s ? [...s].slice(0, 12).join('') : null;
}

/** 房間代碼字元（去掉 0O1I 等易混淆字） */
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function randomCode() {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}
export const normCode = (v) => (typeof v === 'string' ? v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) : '');

export function cleanId(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{8,40}$/.test(v) ? v : null;
}

export function parseMsg(raw) {
  try {
    const m = JSON.parse(raw);
    return m && typeof m === 'object' && typeof m.t === 'string' ? m : null;
  } catch { return null; }
}
