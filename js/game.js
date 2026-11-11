// 遊戲狀態機：loading → playing → (ended) → revealed → 下一題
import { ClipPlayer } from './player.js';
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
    this.player = new ClipPlayer('yt', {
      onPlaying: () => this._onPlaying(),
      onClipEnd: () => this._onClipEnd(),
      onError: (code) => this._onError(code),
      onStuck: () => this._onStuck(),
      onProgress: (elapsed, duration) => ui.setProgress(elapsed, duration, this.auto && this.state === 'playing'),
    });
    this.auto = false;
    if (initialVolume != null) this.player.volume = initialVolume;
    this.ready = this.player.init();
  }

  async start(queue, total, duration, auto = false, fromMiddle = false) {
    await this.ready;
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
    this.player.stop();
    this.state = 'over';
  }

  _present() {
    if (this.shown >= this.total || this.queue.length === 0) return this._end();
    this.player.pause(); // 先停掉上一首
    this.current = this.queue.shift();
    this.shown++;
    this.state = 'loading';
    ui.showQuestion(this.current, this.shown, this.total); // 同步蓋住影片、收起答案，之後才載入新影片
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
    this.player.release(this.current.revealStart);
  }

  _end() {
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
