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

設定畫面可選題數、播放長度、難度、同一作品最多出幾首、歌曲類型。

## 本機執行

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
        │  node scripts/enrich.mjs    從日文維基百科補作詞／作曲（可選）→ data/cache/credits.json
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
- 選填欄位：`l=作詞` `c=作曲` `a=編曲` `q=自訂 YouTube 搜尋字` `d=難度`（1 全民熟知，2 普通）
- 演唱寫 `?` 代表不確定

### 新增題目

1. 在 `data/seeds/` 裡的 `.txt`（或新建一個）加上作品與歌曲
2. 執行：

```bash
node scripts/resolve.mjs     # 只會處理新加的歌；--retry-failed 重試失敗的
node scripts/enrich.mjs      # 補詞曲（可選）
node scripts/build.mjs       # 產生 data/anime.json
```

3. `data/cache/missing.txt` 會列出找不到可嵌入影片的歌，可改 `q=` 搜尋字再重跑，或直接刪掉

### 微調起點、停用題目

開 `preview.html`（需 http 伺服器）：逐首試聽、修改起點秒數（或在播放中按「設為目前位置」）、停用有問題的題目。按「複製 overrides.json」貼進 `data/overrides.json`，再跑 `node scripts/build.mjs` 就會永久生效（不會被重新建置覆蓋）。

> 自動決定的起點只是估計（約落在歌曲前段的副歌附近），有些歌可能剛好是安靜的前奏——用 `preview.html` 修正即可。

## 已知限制

- 影片來自 YouTube，日後若被刪除、設為私人或禁止嵌入，遊戲會自動跳過那一題；可重新執行 `resolve.mjs --force` 更新
- 部分影片開頭可能有 YouTube 廣告（取決於影片與使用者帳號）
- 詞曲唱資料來自歌單與維基百科，冷門歌曲可能缺漏，缺的欄位揭曉時不會顯示
- 手機／平板第一次播放需要點擊畫面（瀏覽器自動播放限制）

## 之後可擴充

- 隊伍、搶答、計分（手機掃 QR 搶答需要 Node.js + WebSocket 後端）
- 歌名／歌手、遊戲 OST、電影主題曲題型（填入對應的 seeds 與 JSON 即可）
