# DESIGN：📐 整篇重排版（Reformat）功能設計規格

> 目的：Bear 一鍵把整篇 Hugo 原稿（一個 Roam page）「依內容重新排版」。
> 本文件是給 Opus 的實作規格；不含程式碼，但每個決策都給了理由與驗收條件。
> 基準版本：extension.js v2（1226 行，2026-07-19）＋ PROTOCOL.md v2。

---

## 0. 決策總覽（三個未定案問題的明確建議）

| 問題 | 建議 | 一句話理由 |
|---|---|---|
| 排版做到什麼程度？ | **混合路線**：LLM（CC）做語意排版判斷，extension 做機械式「零位移驗證」＋原子套用＋備份 | 「依內容」排版必須靠語意判斷（機械規則做不到）；但 LLM 偷改字的風險用機械驗證擋死（fail-closed） |
| 輸出回 Roam 還是只給 CC？ | **回 Roam**（隔離提案樹 → Bear 一鍵套用） | Bear 的改稿工作台在 Roam，套用後可繼續用既有標記／審稿機制；若只在轉 Hugo 端排版，Roam 原稿永遠亂、Bear 得在 md 檔裡審結構 |
| 按鈕放哪？ | **FAB row 第 4 顆「📐 重排版」**，點開一張狀態卡（泡泡） | 它跟 🚀 轉Hugo 同屬「整頁級動作」，放同一排、排在轉Hugo 左邊＝工作流順序（改完 → 排版 → 轉Hugo） |

**與 🚀 轉Hugo 的差異（一句話，寫進按鈕 title）：**
📐 重排版＝把 Roam 原稿的版面整理好、**結果回到 Roam 繼續作業**；🚀 轉Hugo＝內容版面都定了、**整頁打包離開 Roam 產成 Hugo 檔**。

---

## 1. 「重新排版」的精確定義與範圍

### 1.1 In-scope（CC 在提案裡可以做的，全部「不改一個字」）

| 動作 | 具體形式 | 為什麼安全 |
|---|---|---|
| 加標題 | 新增獨立標題 block（`## `＝章節、`### `＝小節，兩級） | 標題是「唯一允許的新增文字」，且有前綴可機械識別、可整塊剔除後驗證 |
| 段落切分 | 過長 block 在**原有標點處**切成多個 block | 純 block 邊界移動，字元不變 |
| 段落合併 | 零碎短 block 直接串接成一個 block（不得補字、補標點） | 同上；需要補標點才通順＝內容問題，只能寫進【建議】 |
| 層級／清單化 | 連續平行短句 block 縮排為某句的子層（Roam 原生 bullet 即清單） | 純樹狀結構調整，零文字變動 |
| 整句加粗 | 對「可直接抄進筆記的臨床結論／判斷整句」加 `**…**`，**全篇新增 ≤5 處**，每處列進變更摘要 | Bear 的招牌強調法（見風格檔 §9）；只加記號不動字；設上限防 AI 式滿版粗體 |
| 清雜訊 | 刪除純空白 block、去掉 block 首尾多餘空白 | whitespace 正規化後驗證仍等值 |

### 1.2 Out-of-scope（明確禁止，CC 只能寫進【建議】給 Bear 走既有「議」流程）

- **任何改字**：換詞、改句、增刪內容、加過場句、修錯字（錯字也不行——那是「潤」的事）。
- **表格化**：散文轉 `{{table}}` 必然重排字元、破壞零位移驗證；表格留給轉 Hugo 階段或「議」標記。
- **段落大搬移／跨節重排**：敘事順序是 Bear 的作者判斷（他的文章有刻意的敘事弧），重排順序＝改文章，不是排版。
- **動既有格式記號**：Bear 已寫的 `**`、`^^`、`[[]]`、`(())`、`{{}}`、圖片連結，原樣保留、不增不減。
- **動特殊子樹**：「🗂 素材／背景」子樹、`🗄` 備份子樹、「✅ 已發佈」行——完全不碰、不納入重排結果。
- 照片 block（`![📷 …](https://composer.agoodbear.com/r/…)`）逐字保留，跟著原本相鄰的段落放（不因排版跟圖文分家）。

### 1.3 三路線比較（為什麼選混合）

| 路線 | 能做到「依內容」？ | 風險 | 判定 |
|---|---|---|---|
| 純機械（extension 就地套規則） | ❌ 只能清空行、normalize 空白；「哪裡該下標題、哪句是珍珠」無法用規則判斷 | 低但無用 | 棄 |
| 純 LLM（打包給 CC、CC 直接改寫回頁面） | ✅ | **違憲**（PROTOCOL §一：CC 不得動原稿）＋ LLM 偷改字無防線 | 棄 |
| **混合**（LLM 出提案、extension 驗證＋套用） | ✅ | LLM 偷改字 → 被零位移驗證擋死；套用是 Bear 按的（extension＝Bear 的手，同 acceptMark 前例） | ✅ 採用 |

---

## 2. 觸發點：UI 設計

### 2.1 按鈕位置與文案

- **FAB row 第 4 顆**，插在 🚀 轉Hugo 的**左邊**（DOM 順序：`📐 重排版` → `🚀 轉Hugo` → `🪟 審稿簾` → `✏️ 標記模式`）。
  左→右＝工作流順序：先排版、後轉檔；且把兩顆「整頁打包」動作放相鄰、開關類放右側，語意分群。
- 文案：`📐 重排版`；有提案待審時變 `📐 排版提案 ●`（加一顆點提示，樣式同 curtainBtn 的 `.on` 高亮邏輯）。
- title（hover 提示）：`整篇重排版：打包給 CC 依內容重排（只動版面、不改一個字），提案回來後在這裡預覽＋一鍵套用。轉Hugo 前的最後整理。`
- CSS：新增 `.ccm-reformat-btn`，配色沿用 FAB 家族（建議淡藍系 `#e8eef8` / border `#b7c9e4` / 字 `#2b5da0`，與轉Hugo 的綠系區隔）。

### 2.2 狀態卡（Bear 原話的「泡泡框」）

點 📐 開一張錨定在 FAB row 上方的卡片（重用 `.ccm-bubble` 視覺語言，`position:fixed`、右下對齊），**依當前頁面狀態顯示三態之一**：

**State A｜尚無提案（頁上查不到 `#cc排版提案`）**
```
📐 整篇重排版
本頁狀態：待處理 0 · 待審 0 · 草稿 0 ✅ 可重排
（未歸零時：⚠️ 還有 N 個標記／M 個草稿，先清完才能重排 → 按鈕鎖住）
（頁首含「✅ 已發佈」時：⚠️ 本頁已發佈封存，排版請直接改 Hugo → 按鈕鎖住）
[📋 打包重排版任務給 CC]   ← 唯一主按鈕（Bear 原話「裡面有一個按鍵」）
```

**State B｜提案已回（查到 `#cc排版提案` root）**
```
📐 排版提案 · 待審
變更摘要：標題 +6｜切分 4｜合併 2｜加粗 3｜清空行 5   ← 讀提案的【變更摘要】block
零位移驗證：✅ 逐字等值 ／ ❌ 第 3 段起內文有位移（顯示首個差異片段）
[👀 對照]（右側欄開提案樹，主欄原稿並排看）
[✅ 套用（原稿自動備份）]   ← 驗證 ❌ 時此鈕鎖住（fail-closed）
[↩ 退回（刪整個提案）]
```

**State C｜已套用、備份還在（查到 `#cc排版備份` root）**
```
📐 已套用重排版
[↺ 還原排版前備份]   [🧹 清除備份]（confirm 後才刪）
```

三態同時成立時優先序 B > C > A（有待審提案先處理）。

---

## 3. 完整流程

```
Bear 點 📐 → State A → [📋 打包]
  ↓ 剪貼簿拿到任務提示，貼給新開的 CC session
CC：讀 PROTOCOL §九 → Roam MCP 讀整頁 → 在頁面最底建一個
  「#cc排版提案 【整篇重排版】YYYY-MM-DD」root block，底下：
    ├─ 【變更摘要】…（子層逐條：每個新標題、每處合併/切分/加粗）
    ├─ 【建議】…（做不到/需改字才能解的問題，只建議不動手；可為空）
    └─ 【重排結果】 ← 其直接子層＝重排後的完整正文樹
  → chat 回對帳清單
  ↓ Bear 回 Roam（或 extension observer 偵測到 tag）
extension：發現 #cc排版提案 → 跑零位移驗證 → FAB 變「📐 排版提案 ●」
  ↓ Bear 點開 State B → 👀 對照（右側欄 vs 主欄）
Bear 按 ✅ 套用 → extension 原子三步：
  ① 頁底建「🗄 排版前備份 YYYY-MM-DD HH:mm #cc排版備份」root（collapsed）
  ② 把現有正文 top-level blocks 依序 move 進備份 root（素材/已發佈行/提案 root 不動）
  ③ 把【重排結果】的子樹依序 move 到頁面 top-level（order 遞增），
     `## `/`### ` 前綴 block 轉成 Roam heading 屬性並去前綴，最後刪提案 root
  → toast「已套用重排版（原稿備份在頁底 🗄）」
Bear 按 ↩ 退回 → 刪整個提案 root（原稿本來就沒動過）
之後任何時候 → State C 可 ↺ 還原（見 §5.2）／🧹 清除備份
```

要點：
- **內容蒐集不經 extension**：跟 copyHugoPrompt 同模式，提示只帶 page uid，CC 自己用 Roam MCP 讀整頁。避免剪貼簿塞全文、維持單一資料源。
- **套用順序刻意先備份後促升**：②做完時全部原稿已安全在備份裡；③中途失敗也零遺失，還原鈕可救。
- 套用前 extension **再驗一次**標記歸零（打包到提案回來之間 Bear 可能又標了新標記）＋重跑零位移驗證。

---

## 4. 零位移驗證（本設計的安全核心）

extension 內建純機械比對，**驗不過就鎖死套用鈕**（fail-closed，只能退回或逐字看差異）：

1. **原稿側**：取頁面 top-level 正文 blocks（排除素材／備份／提案 root／「✅ 已發佈」行），依 `:block/order` 深度優先攤平所有 block 字串。
2. **提案側**：取【重排結果】子樹同樣攤平；**剔除 `## `/`### ` 開頭的標題 block**（唯一合法新增）。
3. **正規化**（兩側同套）：去 `**`、`__`；所有空白（含換行）壓成單一空白；去 block 首尾空白；空字串 block 剔除。
4. 串接比對：等值 → ✅；不等 → ❌ 並定位第一個差異點、卡片顯示前後各 ~20 字。
5. **附加守恆檢查**：兩側 `[[…]]`、`((…))`、`^^…^^`、`{{…}}`、`![…](…)` 的出現次數必須一致（防 CC「文字沒改但把 Bear 的 highlight／block ref／圖片弄丟」——這類位移純文字比對抓不到）。

註：因禁止段落搬移（§1.2），嚴格串接比對成立；若未來開放搬移，此驗證需改成句子多重集比對——這是把搬移列 out-of-scope 的工程理由之一。

---

## 5. 安全設計

### 5.1 閘門

| 時點 | 檢查 | 行為 |
|---|---|---|
| 打包時 | `#請cc修改`＋`#cc提案`＝0 且 `#cc草稿`＝0（重用 `countTagOnPage`） | 未歸零 → **不複製**、toast 列數字（比轉Hugo 更嚴：轉Hugo 是照樣複製讓 CC 擋，重排提示流出去風險更大，就地擋掉） |
| 打包時 | 頁上已有 `#cc排版提案` 或頁首「✅ 已發佈」 | 擋下，提示先處理舊提案／已封存頁直接改 Hugo |
| 套用時 | 重驗標記歸零＋重跑零位移驗證 | 任一不過 → 鎖✅、給原因 |
| 轉Hugo 端 | PROTOCOL §七 增修：`#cc排版提案` 未處理＝第三個歸零條件；`#cc排版備份` 子樹排除不進稿 | CC 端擋 |

為何必須標記歸零才能重排：標記靠 parentUid＋【原文】quote＋第N處錨定，切分／合併／搬移 block 會讓所有錨全斷（底線畫錯處、✅ 套錯 block）。歸零＝無錨可斷。反過來說**不要求「已定稿」**：全新亂稿只要沒標記（早期整理）也可以重排——閘門條件是「當下標記數 0」，不是流程階段。

### 5.2 不可逆風險＝零

- 套用**永不刪原稿**：原稿整樹進 `🗄 排版前備份`（collapsed），Bear 手動 🧹（帶 confirm）前永遠都在。
- **↺ 還原**同樣不刪：把當前正文移進新的 `🗄 還原前狀態 …` root，再把備份子樹促升回來（Bear 套用後若改過字，那些改動也被保住、不會被還原默默吃掉）。
- 唯一的刪除動作＝退回提案（刪的是 CC 的字）與 🧹 清備份（confirm）。

### 5.3 與既有機制的互動

- **待審／草稿標記**：閘門保證套用當下不存在；套用後 Bear 重新標記，錨到新 block，一切照舊。
- **審稿簾**：`curtainByPage` 記的錨 block uid 套用後會進備份 → `restoreCurtainForPage()` 找不到 el 時本來就靜默失敗（extension.js:1034），無需處理；文件註明此已知小損失（重排後簾子回頂）。
- **inline 手打 tag／照片 picker**：不受影響。

---

## 6. CC 提示模板（`copyReformatPrompt()` 產出的完整文字，繁中）

模仿 copyHugoPrompt 的骨架（extension.js:702-724），動態值：`${pg.title}`、`${pg.uid}`、`${日期}`。

```
【整篇重排版 · 排版任務】
行為法典（第一步務必讀）：本機 /Users/tsaojian-hsiung/Desktop/Claude Code專用檔/roam-cc-mark/PROTOCOL.md（§九 整篇重排版；備援 raw：https://raw.githubusercontent.com/agoodbear/roam-cc-mark/main/PROTOCOL.md）
對象：Roam page「${pg.title}」（page uid: ${pg.uid}）
本頁狀態：標記 0／草稿 0（已歸零，可重排）

⚠️ 鐵律（凌駕一切，違反任一條＝任務失敗）：
1. 這是「排版」不是「改稿」。Bear 的每一個字逐字保留：禁改字、禁換詞、禁增刪內容、
   禁修錯字、禁加任何過場句。extension 會逐字機械比對，有位移＝整份提案作廢。
2. 你只能做六件事：
   ① 加標題：獨立 block、前綴「## 」（章節）或「### 」（小節）。標題用語取自 Bear
      內文既有詞彙，短、具體、像 Bear 口氣；禁 AI 腔標題（「深入探討」「淺談」「總結」之類）。
   ② 切分過長段落：只能在原有標點處切，不增刪任何字元。
   ③ 合併零碎段落：直接串接，不得補字補標點（需要補才通順→寫進【建議】，別動手）。
   ④ 層級化：連續平行短句縮排為子層（Roam bullet 即清單）。
   ⑤ 整句加粗：只對「可直接抄進筆記的臨床結論／判斷整句」加 **…**，全篇新增 ≤5 處，
      每處列進變更摘要。Bear 既有的 **、^^、[[]]、(())、{{}}、圖片連結原樣保留、不增不減。
   ⑥ 清雜訊：刪純空白 block。
3. 不碰：「🗂 素材／背景」子樹、「🗄」備份子樹、「✅ 已發佈」行、所有 #標記 block。
   照片 block（![📷 …](composer.agoodbear.com/…)）逐字保留、跟著原本相鄰段落放。
4. 禁止段落搬移／跨節重排（敘事順序是 Bear 的作者判斷）。覺得順序該動→寫進【建議】。
5. 原稿一個 block 都不准動（不 update、不 delete、不 move）。你的全部產出只放進下述提案樹。

步驟：
1. 讀上面 PROTOCOL.md §九。
2. 用 Roam MCP 讀整頁 ${pg.uid}（含所有 block 與層級；素材子樹讀了理解脈絡但不入結果）。
3. 在頁面「最底部」建一個 top-level block：「#cc排版提案 【整篇重排版】${日期}」，其下：
   - 子 block「【變更摘要】標題 +N｜切分 N｜合併 N｜加粗 N｜清空行 N」，其子層逐條列明細
     （每個新標題全文、每處合併/切分/加粗的位置與原文前 10 字）。
   - 子 block「【建議】」：需改字才能解的排版問題，只建議不動手（沒有就寫「無」）。
   - 子 block「【重排結果】」：其直接子層＝重排後的完整正文樹（每個頂層段落一個 block，
     標題 block 用 ##/### 前綴，層級用縮排）。
4. 回 chat 一份對帳清單：各章標題＋每類變更數；若有【建議】逐條列出。
（更多脈絡：查 Supabase handovers 最近幾筆這篇的紀錄。）
```

---

## 7. PROTOCOL.md 增修（Opus 一併改）

1. **新增 §九「整篇重排版」**：收錄 §6 模板中的鐵律 1–5＋提案樹格式＋「`#cc排版提案` root 是 §一.3『不得在原稿區新增 block』的唯一豁免——它是頁面級的標記 block，CC 的字仍然關在標記裡、帶著身分」。
2. **§七 轉 Hugo 增修**：歸零條件加第三條「③ `#cc排版提案`＝0（未處理的排版提案）」；轉稿排除清單加 `#cc排版備份` 子樹。
3. **§六 生命週期圖**：加一條旁支 `#cc排版提案 → Bear ✅ 套用（extension 備份＋promote）／↩ 退回（刪提案）`。

---

## 8. 給 Opus 的實作大綱

### 8.1 新增函式（全放 extension.js，位置照現有分區註解風格）

| 函式 | 放哪（依現況行號） | 內容／重用 |
|---|---|---|
| `queryReformatProposal(pageUid)` | 「打包」區（672 附近） | 重用 `queryByTag` 模式查 `#cc排版提案` root＋其子樹；解析【變更摘要】/【重排結果】uid |
| `copyReformatPrompt()` | 緊鄰 `copyHugoPrompt`（724 後） | 骨架抄 `copyHugoPrompt`：`currentPage()`＋`countTagOnPage` 閘門＋`navigator.clipboard`＋`toast`；閘門不過**不複製** |
| `gatherBodyBlocks(pageUid)` | util 區 | pull 頁面 top-level 樹（`:block/order` 排序、遞迴 children），過濾素材/備份/提案/已發佈行 → 攤平字串陣列。套用與驗證共用 |
| `verifyZeroDrift(bodyTexts, proposalTexts)` | 新分區「── 重排版 ──」 | §4 的正規化＋串接比對＋守恆計數；回 `{ok, firstDiff, counts}` |
| `openReformatCard()` / `buildReformatCard(state)` | UI 區 | 三態卡；視覺重用 `.ccm-bubble` 家族；`fixed` 定位在 FAB 上方 |
| `applyReformat()` | 動作區（`acceptMark` 附近） | §3 原子三步；`createBlock`＋`moveBlock` 逐一 await；`## `→heading 屬性轉換；完畢 `refreshDecorations(true)` |
| `restoreReformatBackup()` / `clearReformatBackup()` | 同上 | §5.2 語意；clear 走 `confirm()` |

### 8.2 UI 接線

- `buildUI()`（extension.js:836-846）：`fabRow.appendChild` 順序改為 reformatBtn → hugoBtn → curtainBtn → toggleBtn；新增 `.ccm-reformat-btn` CSS（injectStyle，1050 起）。
- `refreshDecorations()`（357 起）：每輪順帶查 `#cc排版提案` 是否在本頁 → 切換 FAB 文案 `📐 重排版`／`📐 排版提案 ●`（比照 `updatePill` 的輕量更新，勿每輪重驗零位移——驗證只在開卡與套用時跑）。
- Command palette（1194-1205 與 1221 的 labels 陣列同步）：加「請CC修改：打包『整篇重排版』給 CC」「請CC修改：套用排版提案」「請CC修改：還原排版前備份」。
- `onunload`：移除卡片 DOM。

### 8.3 實作時必須先驗證的 Roam API 假設（❗待確認，勿直接當事實）

1. `window.roamAlphaAPI.moveBlock({location:{"parent-uid",order}, block:{uid}})` 存在且保序——套用/還原全靠它。
2. `updateBlock` 的 `block` 物件支援 `heading`（0–3）與 `open`（collapse 備份 root）欄位。
3. `window.roamAlphaAPI.ui.rightSidebar.addWindow({window:{type:"block","block-uid":…}})` 可用（👀 對照鈕）。若不可用，降級：對照鈕改為捲動＋展開提案 root。
4. 大頁（100+ blocks）逐一 await moveBlock 的耗時——實測若 >3 秒加進度 toast。

### 8.4 驗收清單（實作完逐條過，「完成＝非作者檢查通過」）

1. 有標記時點 📋 打包 → 被擋、未寫入剪貼簿。
2. 歸零後打包 → 剪貼簿內容與 §6 模板逐字一致（動態值正確）。
3. 手動在測試頁造一個合法提案樹 → State B 出現、摘要正確、驗證 ✅。
4. 提案裡偷改一個字／刪一個 `^^`／丟一張圖 → 驗證 ❌、✅ 鈕鎖住、差異定位正確（三種各測）。
5. 套用 → 正文換新、`##` 變 heading、備份樹完整、素材子樹原地不動、原稿逐字可在備份找回。
6. 還原 → 原稿回來、套用後狀態進新備份、無任何 block 消失（前後 block 總數守恆）。
7. 套用後 ⌥M 標記新 block → 底線/泡泡/接受全正常。
8. 轉Hugo prompt 在有未處理提案時 → CC 端擋下（PROTOCOL §七③ 生效）。
9. reload extension（onunload/onload）無殘留 DOM、無重複 listener。

---

## 9. 風格護欄依據（設計時已納入）

- `feedback_hugo_writing_style_human`：人味＝不滿版 bold、不 notice 轟炸 → 加粗設 ≤5 上限、callout 不在 in-scope。
- `reference_ecg_writing_style_profile`：「整句加粗臨床珍珠」是 Bear 招牌、不是 AI 味 → 加粗對象限定「珍珠整句」；標題用語取 Bear 內文詞彙、禁 AI 腔標題。
- `bundle_hugo_blog_ops`／PROTOCOL §八：Bear 的字＝墨水，CC 永遠是鉛筆 → 零位移驗證＋提案隔離＋Bear 唯一套用權，把「排版」跟「改稿」用機器劃清界線。
