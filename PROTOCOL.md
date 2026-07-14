# CC 讀取協定（請CC修改）

CC（Claude Code，透過 Roam MCP 從外部）改稿前**先讀這份**。原稿範圍 = **一個 Roam page**。

## 標記格式（子 block，掛在要改的 block 底下）

```
#請cc修改 【指令】<怎麼改> 【原文】「<要改的精確片段>」
```
- 同段文字重複時會多一個錨點：`【指令】… 【第2處】 【原文】「…」`（改「第 2 次出現」的那處，別改錯）。
- 沒有【原文】= 整段（整個 parent block）都要依指令改。

## 一次讀全（單一 MCP call，不要逐個撈）

用 datalog 一次拿齊「標記字串 + 要改的原文 block uid + 該 block 現有內容 + 頁名」。鎖定某一頁就把 `頁名` 填進去：

```clojure
[:find ?childUid ?markStr ?parentUid ?parentStr ?title
 :where
   [?t :node/title "請cc修改"]
   [?c :block/refs ?t] [?c :block/uid ?childUid] [?c :block/string ?markStr]
   [?p :block/children ?c] [?p :block/uid ?parentUid] [?p :block/string ?parentStr]
   [?p :block/page ?pg] [?pg :node/title ?title]
   [?pg :node/title "<頁名>"]]   ;; 只改某頁就留這行，全 graph 就拿掉
```

Bear 也可以在 extension 右下角點 📋，把上面這些直接打包成一段文字貼給 CC（含 page uid），CC 就零查詢開改。

## 改稿流程（鐵律）

1. **先完整讀整頁**（get_page / 讀 parent 的所屬 page）掌握上下文。
2. 逐處依【指令】修改對應 parent block（update_block）——**參考前後文、保持語氣連貫與原意，不孤立改單句**。
3. 【原文】是精確定位錨點；有【第N處】就改第 N 個出現。
4. 改完把該標記子 block **刪掉**（delete_block）。
5. 全部標記清空 = 定稿 → 可轉 Hugo。

## 未來（狀態機 v2，尚未實作）

之後會改成 CC 不刪、改成回寫「待確認 + 改成什麼 + 備註（查證附來源）」，讓 Bear 就地審核（✅接受才刪 / ↩︎退回）。屆時本檔會更新格式。
