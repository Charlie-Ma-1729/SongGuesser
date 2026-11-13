// 遊戲狀態機：loading → playing → (ended) → revealed → 下一題
import { sharedPlayer } from './player.js';
import * as ui from './ui.js';
import { flagBad } from './questions.js';

export class Game {
  constructor(initialVolume) {
    this.state = 'idle'; // idle | loading | playing | ended | revealed | over
    this.queue = [];
    this.current = null;
    this.shown = 0;
    this.total = 0;
    this.duration = 15;
    this.handlers = {
      onPlaying: () => this._onPlaying(),
      onClipEnd: () => this._onClipEnd(),
      onError: (code) => this._onError(code),
      onStuck: () => this._onStuck(),
      onProgress: (elapsed, duration) => ui.setProgress(elapsed, duration, this.auto && this.state === 'playing'),
    };
    this.player = sharedPlayer(this.handlers); // 與多人模式共用同一個 YouTube 播放器
    this.auto = false;
    if (initialVolume != null && this.player.volume == null) this.player.volume = initialVolume;
    this.ready = this.player.initP;
  }

  async start(queue, total, duration, auto = false, fromMiddle = false, makeChoices = null) {
    await this.ready;
    this.player.h = this.handlers; // 可能剛從多人模式回來，換回單人的事件處理
    this.makeChoices = makeChoices; // (question) => 選項陣列 | null；null/未提供 = 不出選擇題
    this.queue = queue.slice();
    this.total = Math.min(total, queue.length);
    this.duration = duration;
    this.auto = !!auto && duration > 0; // 「不限長度」時沒有時間可倒數，自動模式不適用
    this.fromMiddle = !!fromMiddle; // true = 從「中間（接近高潮）」開始播，沒有資料的題目仍從頭
    this.shown = 0;
    this.state = 'idle';
    this._present();
  }

  /** 主要按鍵：播放中→揭曉；揭曉後→下一題 */
  press() {
    if (this.state === 'revealed') return this._present();
    if (this.state === 'loading' || this.state === 'playing' || this.state === 'ended') this._reveal();
  }

  /** 選擇題：標記大家選的選項（0–7），可改選；揭曉後不再接受 */
  pick(i) {
    if (this.state === 'loading' || this.state === 'playing' || this.state === 'ended') ui.pickChoice(i);
  }

  replay() {
    if (!this.current || this.state === 'revealed') return;
    this.state = 'loading';
    ui.toast('');
    ui.resetProgress(this.duration > 0);
    this.player.replay();
  }

  skip() {
    if (this.state === 'idle' || this.state === 'over') return;
    this.shown--; // 跳過的不算數，改抽下一題
    this._present();
  }

  /** 回報這題有問題（例如開頭不是音樂）：之後不再出現，並立刻換下一題 */
  flagCurrent() {
    if (!this.current || this.state === 'idle' || this.state === 'over') return;
    flagBad(this.current.id);
    ui.toast('已回報這題有問題，之後不會再出現', true);
    this.skip();
  }

  quit() {
    this._clearNextTimer();
    this.player.stop();
    this.state = 'over';
  }

  _present() {
    this._clearNextTimer();
    if (this.shown >= this.total || this.queue.length === 0) return this._end();
    this.player.pause(); // 先停掉上一首
    this.current = this.queue.shift();
    this.shown++;
    this.state = 'loading';
    const choices = this.makeChoices ? this.makeChoices(this.current) : null;
    ui.showQuestion(this.current, this.shown, this.total, choices); // 同步蓋住影片、收起答案，之後才載入新影片
    ui.resetProgress(this.duration > 0);
    this.player.load({
      ytId: this.current.ytId,
      start: (this.fromMiddle && this.current.mid != null ? this.current.mid : this.current.start) || 0,
      duration: this.duration,
    });
  }

  _reveal() {
    this.state = 'revealed';
    ui.showAnswer(this.current);
    ui.revealChoices();
    this.player.release(this.current.revealStart);
    if (this.auto) this._startNextTimer();
  }

  /** 自動模式：揭曉後 10 秒自動進下一題（按鈕上顯示倒數；手動按空白鍵／跳過仍可提前進） */
  _startNextTimer(seconds = 10) {
    this._clearNextTimer();
    let n = seconds;
    ui.setNextCountdown(n);
    this._nextTimer = setInterval(() => {
      if (this.state !== 'revealed') return this._clearNextTimer();
      n--;
      if (n <= 0) { this._clearNextTimer(); this._present(); }
      else ui.setNextCountdown(n);
    }, 1000);
  }

  _clearNextTimer() {
    if (this._nextTimer) { clearInterval(this._nextTimer); this._nextTimer = null; }
  }

  _end() {
    this._clearNextTimer();
    this.player.stop();
    this.state = 'over';
    ui.showEnd(Math.min(this.shown, this.total));
  }

  _onPlaying() {
    if (this.state === 'loading' || this.state === 'ended') {
      this.state = 'playing';
      ui.setPlaying(true);
    }
  }

  _onClipEnd() {
    if (this.state === 'playing') {
      if (this.auto) return this._reveal(); // 自動模式：時間到直接揭曉（之後仍要手動才進下一題）
      this.state = 'ended';
      ui.setClipEnded();
    }
  }

  _onError(code) {
    if (this.state === 'revealed' || this.state === 'over' || this.state === 'idle') return;
    console.warn('影片無法播放，已跳過', this.current && this.current.id, '錯誤碼', code);
    ui.toast('這首影片無法播放，已自動換下一題', true);
    this.shown--; // 不算數
    this._present();
  }

  _onStuck() {
    if (this.state === 'loading') ui.toast('沒有聲音？點一下頁面後按 R 重播', true);
  }
}
