// 多人模式計分（純函式；伺服器使用，也可單元測試）
export const SCORE_MODES = ['speed', 'fixed', 'combo'];
export const SCORE_MODE_LABEL = {
  speed: '速度加成（越快越高）',
  fixed: '固定分數（不計速度）',
  combo: '速度加成 + 連對加成',
};

export const BASE = 600; // 速度模式：答對基本分
export const SPEED_MAX = 400; // 速度模式：最高加成
export const FIXED = 100; // 固定模式：答對分數
export const COMBO_STEP = 50; // 連對每多一題加的分
export const COMBO_CAP = 250; // 連對加成上限
export const PENALTY = 100; // 答錯倒扣（需開啟）

/**
 * 計算單題得分。
 * @param {{correct:boolean, answered:boolean, elapsedMs:number, windowMs:number, mode:string, streak:number, penalty:boolean}} a
 *   streak = 這題之前已連續答對的題數
 * @returns {{points:number, streak:number}} streak = 這題之後的連對數
 */
export function scoreAnswer({ correct, answered, elapsedMs, windowMs, mode, streak = 0, penalty = false }) {
  if (!answered) return { points: 0, streak: 0 };
  if (!correct) return { points: penalty ? -PENALTY : 0, streak: 0 };
  const left = windowMs > 0 ? Math.max(0, Math.min(1, 1 - elapsedMs / windowMs)) : 0;
  const speed = BASE + Math.round(SPEED_MAX * left);
  let points;
  if (mode === 'fixed') points = FIXED;
  else if (mode === 'combo') points = speed + Math.min(COMBO_CAP, COMBO_STEP * streak);
  else points = speed;
  return { points, streak: streak + 1 };
}

/**
 * 排行榜：分數高者在前；同分比答對題數（多者在前），再比平均作答時間（短者在前）。
 * 名次依「分數」並列（同分同名次，下一名跳號，例如 1、1、3）。
 * @param {{id:string, score:number, correct:number, answered:number, totalMs:number}[]} players
 */
export function rankPlayers(players) {
  const avg = (p) => (p.correct > 0 ? p.totalMs / p.correct : Infinity);
  const sorted = players.slice().sort((a, b) =>
    b.score - a.score || b.correct - a.correct || avg(a) - avg(b));
  let rank = 0;
  return sorted.map((p, i) => {
    if (i === 0 || p.score !== sorted[i - 1].score) rank = i + 1;
    return { ...p, rank, avgMs: Number.isFinite(avg(p)) ? Math.round(avg(p)) : null };
  });
}
