# 🎵 動漫猜歌大賽（SongGuesser）

一個畫面、大家一起玩的團康猜歌遊戲。播放一小段動漫歌曲／OST，大家猜是哪部動畫，按一下空白鍵揭曉（歌名、作品、演唱／作詞／作曲）。

- 純前端，無需後端、無需打包，可直接放 GitHub Pages
- 音樂用 YouTube 嵌入播放（題庫只記錄影片 ID 與起始秒數，不存音檔）
- 目前題庫：動漫（OP／ED／插入曲／OST）；歌名歌手、遊戲 OST、電影配樂的題庫位置已預留（`data/song.json`、`data/ost.json`、`data/movie.json`）

## 怎麼玩

| 操作 | 作用 |
| --- | --- |
| `空白鍵` | 播放中 → 揭曉答案；揭曉後 → 下一題 |
| `R` | 重播這一題的片段 |
| `→` | 跳過這題（不計入題數） |
| `↑` `↓` | 音量 ±5（也可拖曳滑桿；`M` 靜音／取消靜音；音量會記住） |
| `X` | 回報這題有問題（例如開頭不是音樂）：立刻跳過，之後在這台瀏覽器不再出現 |

設定畫面可選題數、播放長度、揭曉方式、難度、同一作品最多出幾首、歌曲類型。播放中有跑條；選「自動」揭曉時，播完前 5 秒會大字倒數並自動揭曉，揭曉後仍要手動按空白鍵進下一題。

## 多人模式（需要 Node 伺服器）

單人模式維持純前端（GitHub Pages 就能玩）。多人模式由 `server/` 的 Node 伺服器負責：房主開房間、其他人用 4 碼代碼或邀請連結加入，大家**各自播放、各自作答**，伺服器判分並產生排行榜。

- **流程**：房主設規則 → 開始 → 每題：全員預載影片 → 伺服器發「開播時間」（用 NTP 式對時，各裝置同時開播）→ 作答／鎖定 → 達門檻倒數或全員鎖定 → 揭曉（誰答對、各得幾分）→ … → 最終排行榜（頒獎台＋表格）
- **作答**：8 選 1（預設），或打字搜尋作品名後點選；先選、再按「鎖定」（鍵盤：`1`–`8` 選、空白鍵／Enter 鎖定）。過程中大家看得到「已鎖定 n / N」與誰鎖定了（看不到選了什麼）
- **鎖定門檻倒數**：房主可選「過半玩家／全員／指定人數／不倒數」，達標後開始倒數 N 秒，倒數結束就揭曉；全員鎖定則立刻揭曉
- **計分**（房主選）：速度加成（600～1000，依作答速度）／固定分數（100）／速度＋連對加成；可開「答錯倒扣」。作答時間以**每個人自己實際開始聽到音樂**的時間起算，載入慢不吃虧
- **播放方式**：預設各自播放；也可選「**主畫面播放**」——用另一個分頁／裝置按「🖥 開啟主畫面」（或加入時勾「作為主畫面」），只有主畫面出聲，手機只作答，避免同一個房間多支手機的回音
- **其他**：斷線重連（同一分頁重新整理會自動回座並保留分數）、房主離開自動移轉、踢人、中途加入（房主可關）、某人的影片無法播放時只跳過那個人（多數人失敗則換題）、音樂結束後可設作答寬限秒數、揭曉後可設自動下一題
- 電腦（寬螢幕，適合投影）與手機（直立）都有對應版面

### 啟動

```bash
npm ci --omit=dev          # 只需要一個依賴：ws
npm start                  # http://localhost:6713 （PORT、HOST 可用環境變數改）
```

伺服器同時提供網頁，所以玩家直接開 `http://你的主機:6713/` 就能玩多人。測試：`npm test`（計分與房間狀態機的單元測試），`npm run simulate -- --bots 6`（機器人用真的 WebSocket 跑完整局）。

| 環境變數 | 預設 | 說明 |
| --- | --- | --- |
| `PORT` | `6713` | 監聽埠 |
| `HOST` | `0.0.0.0` | 監聽位址（放在反向代理後面建議 `127.0.0.1`） |
| `ALLOWED_ORIGINS` | 空 | 網頁與伺服器不同網域時（例如網頁在 GitHub Pages），允許連線的網頁來源，逗號分隔，如 `https://yourname.github.io`。同網域永遠允許 |
| `MAX_ROOMS` | `200` | 同時存在的房間上限 |

### 部署（systemd + 反向代理）

- `deploy/songguesser.service`：systemd 範例（內有安裝步驟；`systemctl reload` 會熱重新載入題庫，`restart` 會清掉所有房間）
- `deploy/nginx.conf.example`：nginx 範例（`/ws` 要開 WebSocket Upgrade；也附 Caddy 兩行版）
- 公開上線一定要 HTTPS（瀏覽器在 https 網頁上只允許 `wss://`）
- `GET /healthz` 回傳房間數、人數、題數，可給監控用
- 只靜態提供 `index.html`、`css/`、`js/`、`data/*.json`；`data/cache`、`data/seeds`、`scripts` 不會對外

**網頁放 GitHub Pages、伺服器另外放**：把 `js/config.js` 的 `MULTI_WS_URL` 改成 `wss://你的網域/ws`，並在伺服器設 `ALLOWED_ORIGINS=https://<帳號>.github.io`。之後單人直接在 Pages 玩，多人也可以從 Pages 進（邀請連結會是 Pages 的網址）。

### 限制與注意

- 房間存在伺服器記憶體裡：伺服器重啟＝所有房間消失
- 手機（尤其 iOS Safari）的自動播放限制：每次進入遊戲的第一題，若瀏覽器不允許自動啟用聲音，畫面會提示「點一下這裡啟用聲音」，點一次之後整局都可以自動播放
- 題目與正解只存在伺服器，揭曉前不會傳給玩家；但影片 ID 一定要給玩家的瀏覽器才能播放，懂技術的人可以從網路請求查到影片網址（派對遊戲不處理這種作弊）
- 單人模式的「回報問題（X）」不影響多人；多人只有房主可「跳過本題」

## 本機執行（單人）

ES Modules 與 YouTube 播放器需要 http 環境（不能直接點兩下開 `index.html`）：

```bash
npx serve .
```

然後開 http://localhost:3000。

## 部署到 GitHub Pages

1. 在 GitHub 建立 repo，把整個資料夾推上去（`git init` → `git add .` → `git commit` → `git push`）
2. 到 repo 的 **Settings → Pages**，Source 選 **Deploy from a branch**，Branch 選 `main` / `(root)`
3. 幾分鐘後網址就會是 `https://<帳號>.github.io/<repo 名稱>/`

## 題庫怎麼來、怎麼維護

題庫不是手寫 JSON，而是由「歌單」自動產生：

```
data/seeds/*.txt          歌單（以作品為單位，每首歌一行）
        │  node scripts/resolve.mjs   自動搜尋 YouTube、驗證可嵌入 → data/cache/resolved.json
        │  data/seeds/credits.tsv     以歌名補作詞／作曲（歌單沒填的才會補）
        │  data/overrides.json        手動調整（起點秒數、停用）
        ▼  node scripts/build.mjs
data/anime.json           遊戲實際讀取的題庫
```

### 歌單格式（`data/seeds/*.txt`）

```
# 鬼滅之刃（鬼滅の刃） | 2019
OP | 紅蓮華 | LiSA | l=LiSA c=草野華余子
ED | from the edge | FictionJunction feat. LiSA
OST | 竈門炭治郎のうた | 椎名豪 feat. 中川奈美
```

- `# 作品中文（日文） | 年份` 開始一部作品；同一部作品可以有多首歌
- 歌曲行：`類型 | 歌名 | 演唱 | 選填欄位`，類型為 `OP` / `ED` / `INSERT` / `OST`
- 選填欄位：`l=作詞` `c=作曲` `a=編曲` `q=自訂 YouTube 搜尋字` `t=別名/別名`（影片標題可能用的其他寫法，如英文名）`d=難度`（1 全民熟知，2 普通）
- 演唱寫 `?` 代表不確定
- 作詞／作曲也可以寫在 `data/seeds/credits.tsv`（`歌名|作詞|作曲|編曲`，沒有的填 `-`）；詞曲不是必填，沒有的欄位揭曉時不會顯示

### 自動從 MyAnimeList 擴充歌單

```bash
node scripts/fetch-mal.mjs --years 2012-2026 --works 240   # 抓人氣最高的作品與它們的 OP/ED → data/seeds/10-mal.txt
node scripts/resolve.mjs                                   # 幫新歌找 YouTube 影片
node scripts/build.mjs
```

- `data/seeds/mal-extra.list`：想指定一定要收的作品，每行寫一個英文／羅馬字作品名（或 MAL 編號）
- `node scripts/fetch-wiki.mjs`：從日文維基百科補插入歌／劇中歌與 MAL 漏掉的 OP/ED（寫到 `11-wiki.txt`）
- `data/seeds/names.tsv`：作品的台灣譯名對照（`日文原名 | 台灣譯名`），只影響顯示
- 各季會依 Prequel 合併成同一部作品；中文名取自 Wikidata，沒有就用英文名
- 已經出現在其他歌單的作品／歌曲不會重複；`10-mal.txt` 是自動產生的，不要手動改
- 前 90 名人氣作品難度 1，其餘難度 2

### 新增題目

1. 在 `data/seeds/` 裡的 `.txt`（或新建一個）加上作品與歌曲
2. 執行：

```bash
node scripts/resolve.mjs     # 只會處理新加的歌；--retry-failed 重試失敗的
node scripts/build.mjs       # 產生 data/anime.json
```

3. `data/cache/missing.txt` 會列出找不到可嵌入影片的歌，可改 `q=` 搜尋字再重跑，或直接刪掉

### 微調起點、停用題目

開 `preview.html`（需 http 伺服器）：逐首試聽、修改起點秒數（或在播放中按「設為目前位置」）、停用有問題的題目。按「複製 overrides.json」貼進 `data/overrides.json`，再跑 `node scripts/build.mjs` 就會永久生效（不會被重新建置覆蓋）。

> 猜歌時一律從影片開頭播放；按下揭曉後，若有 YouTube「最多重播」資料，會跳到那個位置（通常是副歌）繼續播，沒有資料的影片就接著播（題庫欄位 `revealStart`，可在 `overrides.json` 針對單題改）。所以挑影片時優先選「一開始就是音樂」的類型（歌詞版、ノンクレジット OP/ED、官方音源），`preview.html` 勾「只看需確認的」是不屬於這類、開頭可能有對白或劇情的影片。真的需要從別處開始，可在 `overrides.json` 針對單題設定 `start`。

## 已知限制

- 影片來自 YouTube，日後若被刪除、設為私人或禁止嵌入，遊戲會自動跳過那一題；可重新執行 `resolve.mjs --force` 更新
- 部分影片開頭可能有 YouTube 廣告（取決於影片與使用者帳號）
- 詞曲唱資料來自歌單與 `credits.tsv`，不是每首都有；缺的欄位揭曉時不會顯示
- 手機／平板第一次播放需要點擊畫面（瀏覽器自動播放限制）

## 之後可擴充

- 多人：隊伍賽、QR Code 加入、房間內暱稱改名
- 歌名／歌手題型（填入對應的 seeds 與 JSON 即可）
