# 原稿改稿助手（請CC修改）· Roam extension

框選 block 內文字 → 彈出輸入框 → 送出後在該 block 底下自動建一個
`#請cc修改 【指令】… 【原文】「…」` 子 block（CC 讀取用）。
被標記的字常駐淡黃底線，滑鼠移上去浮出泡泡框顯示指令。

## 怎麼裝進 Roam（本機 developer extension）

1. 打開 Roam（桌面 App 或網頁版都可）。
2. 右上齒輪 → **Settings** → 左側找 **Roam Depot**。
3. 進 Roam Depot 頁面，找到 **Developer mode / 開發者模式** 開關 → 打開。
4. 開發者模式打開後會出現「載入本機 extension」的入口 → 選擇這個資料夾：
   `/Users/tsaojian-hsiung/Desktop/Claude Code專用檔/roam-cc-mark`
5. 載入後就生效。之後我更新程式碼，你只要回這裡按 **reload/reinstall** 即可。

> 找不到開發者模式入口的話，截圖給我，我對著你的 Roam 版本給精準位置。

## 怎麼用

- 在任一 block **框選一段文字** → 自動彈出「請CC修改」輸入框。
- 打指令，或點下方標籤（口語化／縮短／去 AI 腔／補來源／改台灣用語／查證數字）快速填。
- **Enter 送出**（Shift+Enter 換行）。
- 送出後：該 block 底下多一個 `#請cc修改` 子 block，選的字加上淡黃底線。
- 滑鼠移到底線文字上 → 浮出泡泡框看指令；泡泡右上 ✕ 可刪除該標記。
- 右下角膠囊顯示「待改 N」，點它跳到第一個標記。

## CC 怎麼接手

跟你現在的流程完全一樣：CC 讀該頁的 `#請cc修改` 子 block（parent 就是要改的 block、
【原文】就是要改的片段、【指令】就是怎麼改），改完 **刪掉該子 block**，底線與泡泡就跟著消失。
全部清空 = 定稿，可轉 Hugo。

## 設定（Settings → 請CC修改標記）

- **標記 tag**：預設 `請cc修改`。若你既有的 tag 不同，改這裡。
- **泡泡框顯示**：`hover`（滑過才出，預設）或 `always`（常駐顯示）。

## 已知限制（會在下一輪處理）

- 若框選範圍**橫跨粗體／block reference 等內嵌元素**，底線可能改成整段 block 標記（退化模式），
  但子 block 一定正確、CC 一定讀得到。
- 原文被改動後找不到原字串時，同樣退化為整段 block 標記。
