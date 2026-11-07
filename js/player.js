// YouTube IFrame API 封裝：載入片段、到時間自動暫停、錯誤回報
let apiPromise = null;

function loadApi() {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    if (window.YT && window.YT.Player) return resolve();
    window.onYouTubeIframeAPIReady = () => resolve();
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => reject(new Error('無法載入 YouTube 播放器（請檢查網路）'));
    document.head.appendChild(s);
  });
  return apiPromise;
}

export class ClipPlayer {
  /**
   * @param {string} elId 放播放器的元素 id
   * @param {{onPlaying?:Function, onClipEnd?:Function, onError?:(code:number)=>void, onStuck?:Function}} handlers
   */
  constructor(elId, handlers = {}) {
    this.elId = elId;
    this.h = handlers;
    this.yt = null;
    this.clip = null;
    this.free = false; // true = 不限制長度（揭曉後讓它自然播完）
    this.timer = null;
    this.stuckTimer = null;
    this.ready = false;
    this.pending = null;
  }

  async init() {
    await loadApi();
    await new Promise((resolve) => {
      this.yt = new YT.Player(this.elId, {
        width: '100%',
        height: '100%',
        playerVars: {
          controls: 0, disablekb: 1, rel: 0, playsinline: 1, fs: 0,
          modestbranding: 1, iv_load_policy: 3, origin: location.origin,
        },
        events: {
          onReady: () => {
            this.ready = true;
            if (this.volume != null) this.setVolume(this.volume);
            resolve();
          },
          onStateChange: (e) => this._onState(e.data),
          onError: (e) => this._onError(e.data),
        },
      });
    });
    this.timer = setInterval(() => this._tick(), 150);
  }

  /** 音量 0~100（同時記住，換題後仍套用） */
  setVolume(v) {
    this.volume = Math.max(0, Math.min(100, Math.round(v)));
    if (!this.ready) return;
    try {
      this.yt.setVolume(this.volume);
      if (this.volume === 0) this.yt.mute(); else this.yt.unMute();
    } catch { /* ignore */ }
  }

  /** @param {{ytId:string,start:number,duration:number}} clip duration=0 表示不限 */
  load(clip) {
    this.clip = clip;
    this.free = !clip.duration;
    this._armStuck();
    this.yt.loadVideoById({ videoId: clip.ytId, startSeconds: clip.start });
  }

  replay() {
    if (!this.clip) return;
    this.free = !this.clip.duration;
    this._armStuck();
    this.yt.seekTo(this.clip.start, true);
    this.yt.playVideo();
  }

  /** 揭曉後解除長度限制，繼續播放 */
  release(jumpTo) {
    this.free = true;
    clearTimeout(this.stuckTimer);
    try {
      if (typeof jumpTo === 'number') this.yt.seekTo(jumpTo, true); // 揭曉：跳到最多重播的地方
      if (typeof jumpTo === 'number' || this.yt.getPlayerState() !== YT.PlayerState.PLAYING) this.yt.playVideo();
    } catch { /* ignore */ }
  }

  /** 切歌前先暫停上一首（避免上一首的聲音／畫面殘留到下一題） */
  pause() {
    this.clip = null;
    clearTimeout(this.stuckTimer);
    try { this.yt.pauseVideo(); } catch { /* ignore */ }
  }

  stop() {
    this.clip = null;
    clearTimeout(this.stuckTimer);
    try { this.yt.stopVideo(); } catch { /* ignore */ }
  }

  _armStuck() {
    clearTimeout(this.stuckTimer);
    this.stuckTimer = setTimeout(() => this.h.onStuck && this.h.onStuck(), 7000);
  }

  _tick() {
    if (!this.ready || !this.clip || this.free) return;
    let state;
    try { state = this.yt.getPlayerState(); } catch { return; }
    if (state !== YT.PlayerState.PLAYING) return;
    const t = this.yt.getCurrentTime();
    if (this.clip.duration && this.h.onProgress) this.h.onProgress(Math.max(0, t - this.clip.start), this.clip.duration);
    if (t >= this.clip.start + this.clip.duration) {
      this.yt.pauseVideo();
      this.h.onClipEnd && this.h.onClipEnd();
    }
  }

  _onState(s) {
    if (s === YT.PlayerState.PLAYING) {
      clearTimeout(this.stuckTimer);
      if (this.volume != null) this.setVolume(this.volume);
      this.h.onPlaying && this.h.onPlaying();
    }
  }

  _onError(code) {
    clearTimeout(this.stuckTimer);
    this.h.onError && this.h.onError(code);
  }
}
