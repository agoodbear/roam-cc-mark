// ────────────────────────────────────────────────────────────────
// 請CC修改 · Roam developer extension  v2（Bear 主筆、CC 批註輔助）
//
// 模型：紙是 Bear 的，紅圈是 Bear 畫的；CC 只能在標記裡寫「提案」（鉛筆字），
//       Bear 按 ✅ 才把字套進原稿（變墨水）。CC 永遠不直接改原稿。
//
// 意圖（框選後選）：潤 / 接 / 查 / 議
//   潤=改這句(替換) 接=起一段草稿(插入) 查=查證/補來源(註記) 議=給選項(註記)
// 顏色：淡黃底線=待處理(等CC)   綠底線=待審(CC 已提案，等你 ✅/↩)
//
// 鍵盤：⌥M 標記(沒選取=整段) · 面板 ⌥1–4 選意圖 · ⌥↓/⌥↑ 跳標記
// 右下：開關(關=零干擾) · 待處理n·待審m 膠囊 → ▲▼導覽 + 📋 打包本頁待處理給CC
// 真相=Roam 子 block；畫面每次從 graph 重讀重畫。CC 端行為見同資料夾 PROTOCOL.md。
// ────────────────────────────────────────────────────────────────

// ⚠️ 改完程式碼一定要 bump 這個版本號 —— 它是 Bear reload 後唯一能確認「新碼有沒有上」的訊號。
// （2026-09-08 踩過：改了跨 block 支援卻沒 bump，Bear reload 後看到的還是 v11 的 toast，
//   完全無法判斷載入成功與否。版本號散在 toast 字串裡是根因，故抽成常數。）
const CCM_VERSION = "v12";
const CCM_VERSION_NOTE = "跨 block 標記：框選連續多段＝一個標記（含【範圍】），套用可分段替換或合併";

const TODO_TAG = "請cc修改";
const PROP_TAG = "cc提案";
const DRAFT_TAG = "cc草稿";
const REFORMAT_PROP_TAG = "cc排版提案";     // 整篇重排版：CC 回寫的提案 root（頁面級標記 block）
const REFORMAT_BACKUP_TAG = "cc排版備份";   // 套用重排後，原稿整樹搬進的 🗄 備份 root
const BC_URL = "https://composer.agoodbear.com";   // Blog Composer（照片庫，picker 彈窗來源）
const INTENTS = ["潤", "接", "查", "議"];
const INTENT_HINT = { "潤": "改這句（口語化/縮短/去AI腔…）", "接": "幫我起一段草稿", "查": "查證/補來源，不改字", "議": "給我選項/建議" };

let api;
let styleEl, overlayEl, panelEl, pillEl, triggerBtn, toggleBtn, navEl;
let observer, debounceTimer, applying = false, active = false, navIdx = -1, navCurrent = null, navBubble = null, navScrolling = false;
let hoverBubble = null, hoverAnchor = null, hoverHideT = null;   // 泡泡 singleton：全畫面同時只留一顆
let pinnedBubble = null;   // 點一下釘住的泡泡（釘住時 hover 停用，可安穩移去按 ✅/↩）
let pending = null;            // create:{mode,marks:[{parentUid,quote,occurrence}],label} | edit:{mode,childUid,quote,occurrence}
let panelIntent = "潤";
let scrollBound = null, keyBound = null, mdBound = null, photoMsgBound = null;
let photoPopup = null, photoLastUid = null;   // Blog Composer 照片 picker：連續挑照片時把新 block 鏈在後面
let fabRow = null, curtainBtn = null, hugoBtn = null, reformatBtn = null, reformatCard = null;   // reformatBtn=FAB 第4顆；reformatCard=三態卡（fixed，錨在 FAB 上方）
let curtainOn = false, curtainEl = null, curtainGrip = null, curtainEdge = null;   // 審稿簾：蓋住已審區、握把/虛線拖曳追蹤進度
let curtainAnchor = 240, curtainOpacity = 0.4, curtainDragging = false, curtainScroller = null, curtainDragY = 0;   // curtainDragY=拖曳中游標最後的視窗 Y（滾輪捲頁時線要留在游標下）
let curtainCapture = null, refreshDeferred = false;   // 拖曳中 pointer 鎖在哪個元素；拖曳期間被凍結的 refresh 要不要在放開後補跑
let curtainByPage = {}, curtainPageUid = null, curtainRangeCache = null;   // 每頁各自記「審到哪個 block」＋原稿頭尾範圍（算進度%）
const CURTAIN_TOP = "^top";   // curtainByPage 的哨兵值：這頁審稿線歸零（從頭開始），不是 block uid

// ── util ──────────────────────────────────────────────────────
function uidFromId(el) {
  if (el && el.id) { const m = el.id.match(/([A-Za-z0-9_\-]{9})$/); if (m) return m[1]; }
  return null;
}
function getUidFromNode(node) {
  let el = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  if (!el || !el.closest) return null;
  const host = el.closest('.rm-block-text, .roam-block, [id^="block-input"]');
  if (host) { const u = uidFromId(host); if (u) return u; }
  const rb = el.closest('.roam-block');
  if (rb) { const u = uidFromId(rb); if (u) return u; }
  return null;
}
function occurrenceOf(fullText, needle, startOffset) {
  if (!needle) return 1;
  let total = 0, idx = 0;
  while (true) { const i = fullText.indexOf(needle, idx); if (i === -1) break; total++; idx = i + needle.length; }
  if (total <= 1) return 1;
  let before = 0; idx = 0;
  while (true) { const i = fullText.indexOf(needle, idx); if (i === -1 || i >= startOffset) break; before++; idx = i + needle.length; }
  return before + 1;
}
function offsetInContainer(container, node, nodeOffset) {
  let offset = 0;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  let n;
  while ((n = walker.nextNode())) { if (n === node) return offset + nodeOffset; offset += n.nodeValue.length; }
  return 0;
}

// 解析標記 block 字串
function parseMark(s) {
  const review = /#cc提案|#\[\[cc提案\]\]/.test(s);
  // 照欄位邊界切段（不靠 「」 當界）→ 原文/提案內含對話引號「我不要住院」也不會被截斷
  const seg = (marker, ...nexts) => {
    const st = s.indexOf(marker);
    if (st === -1) return null;
    const from = st + marker.length;
    let end = s.length;
    for (const nm of nexts) { const i = s.indexOf(nm, from); if (i !== -1 && i < end) end = i; }
    return s.slice(from, end).trim();
  };
  const unquote = (v) => (v == null ? "" : v.replace(/^「/, "").replace(/」$/, ""));
  let intent = "潤", detail = "";
  const insRaw = seg("【指令】", "【範圍】", "【第", "【原文】", "【提案】", "【備註】");
  if (insRaw != null) {
    const im = insRaw.match(/^(潤|接|查|議)\s*[:：]?\s*([\s\S]*)$/);
    if (im) { intent = im[1]; detail = im[2].trim(); } else detail = insRaw;
  }
  const occ = s.match(/【第(\d+)處】/);
  return {
    state: review ? "review" : "todo", intent, instruction: detail,
    occurrence: occ ? parseInt(occ[1], 10) : 1,
    quote: unquote(seg("【原文】", "【提案】", "【備註】")),
    rangeUids: (function () {
      const r = seg("【範圍】", "【第", "【原文】", "【提案】", "【備註】");
      if (!r) return null;
      const ids = r.match(/[A-Za-z0-9_-]{9}/g);
      return ids && ids.length ? ids : null;
    })(),
    proposal: unquote(seg("【提案】", "【備註】")),
    note: seg("【備註】") || "",
  };
}
function markString(intent, instruction, quote, occurrence, rangeUids) {
  const head = instruction ? `${intent}：${instruction}` : intent;
  let s = `#${TODO_TAG} 【指令】${head}`;
  // 跨 block 標記：一個標記涵蓋連續數段（Bear 框選 A、B 是因為它們在講同一件事，
  // 拆成兩個獨立標記會讓 CC 兩邊都看不到全貌）。範圍記 uid 純文字，不用 (( )) —
  // block ref 的預覽會夾帶對方的圖片，逐行掃描時會誤判。
  if (Array.isArray(rangeUids) && rangeUids.length > 1) {
    s += ` 【範圍】共 ${rangeUids.length} 段：本段 + ${rangeUids.slice(1).join(" ")}`;
  }
  if (quote) { if (occurrence > 1) s += ` 【第${occurrence}處】`; s += ` 【原文】「${quote}」`; }
  return s;
}

function queryByTag(tagTitle) {
  try {
    const q = `[:find ?cu ?pu ?s ?pageuid ?ps
      :where [?t :node/title "${tagTitle}"]
        [?c :block/refs ?t] [?c :block/uid ?cu] [?c :block/string ?s]
        [?p :block/children ?c] [?p :block/uid ?pu] [?p :block/string ?ps]
        [?p :block/page ?pg] [?pg :block/uid ?pageuid]]`;
    return window.roamAlphaAPI.q(q) || [];
  } catch (e) { console.warn("[請CC修改] query failed", e); return []; }
}
// #cc草稿 常掛在「頂層正文 block」（父＝page、無 :block/string）→ queryByTag 硬要父 block 有字會漏掉它。
// 改用 :block/page 直接取頁面。回 [cu, pageuid, s]（草稿的 parentUid＝自己，不需父 uid）。2026-07-19 live 驗：queryByTag 漏抓、此法抓到本頁 3 筆。
function queryDraftTag() {
  try {
    const q = `[:find ?cu ?pageuid ?s
      :where [?t :node/title "${DRAFT_TAG}"]
        [?c :block/refs ?t] [?c :block/uid ?cu] [?c :block/string ?s]
        [?c :block/page ?pg] [?pg :block/uid ?pageuid]]`;
    return window.roamAlphaAPI.q(q) || [];
  } catch (e) { console.warn("[請CC修改] draft query failed", e); return []; }
}
function queryMarks() { return [...queryByTag(TODO_TAG), ...queryByTag(PROP_TAG)]; }

function findBlockTextEl(uid) {
  const els = document.querySelectorAll('.rm-block-text, .roam-block');
  for (const el of els) if (el.id && el.id.endsWith(uid)) return el;
  for (const el of els) if (el.id && el.id.indexOf(uid) !== -1) return el;
  return document.querySelector('[id^="block-input"][id$="' + uid + '"]');
}
// 從網址列同步讀目前開的 page/block uid（getOpenPageOrBlockUid 在某些版本回 Promise，不能用）
function currentOpenUid() {
  try { const m = (window.location.hash || "").match(/\/page\/([^\/?]+)/); return m ? decodeURIComponent(m[1]) : null; }
  catch (e) { return null; }
}
function currentPage() {
  try {
    const uid = currentOpenUid();
    if (!uid) return null;
    const p = window.roamAlphaAPI.pull("[:node/title :block/uid {:block/page [:node/title :block/uid]}]", [":block/uid", uid]);
    if (p && p[":node/title"]) return { uid, title: p[":node/title"] };
    if (p && p[":block/page"]) return { uid: p[":block/page"][":block/uid"], title: p[":block/page"][":node/title"] };
    return null;
  } catch (e) { return null; }
}

// ── 畫底線 + 泡泡 ────────────────────────────────────────────
function wrapNeedle(container, needle, m, cls) {
  if (!needle) return null;
  const occurrence = m.occurrence || 1;
  let seen = 0;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  let n;
  while ((n = walker.nextNode())) {
    let from = 0;
    while (true) {
      const idx = n.nodeValue.indexOf(needle, from);
      if (idx === -1) break;
      seen++;
      if (seen === occurrence) {
        const range = document.createRange();
        range.setStart(n, idx); range.setEnd(n, idx + needle.length);
        const span = document.createElement("span");
        span.className = cls;
        span.dataset.child = m.childUid; span.dataset.state = m.state;
        try { range.surroundContents(span); } catch (e) { return null; }
        return span;
      }
      from = idx + needle.length;
    }
  }
  return null;
}

function decorateMark(el, m) {
  const cls = m.state === "review" ? "ccm-underline-review" : (m.state === "draft" ? "ccm-underline-draft" : "ccm-underline");
  let anchor = m.quote ? wrapNeedle(el, m.quote, m, cls) : null;
  if (!anchor) {
    el.classList.add(m.state === "review" ? "ccm-block-flag-review" : (m.state === "draft" ? "ccm-block-flag-draft" : "ccm-block-flag"));
    el.dataset.ccmChild = m.childUid; el.dataset.state = m.state;
    anchor = el;
    // 草稿：點一下釘住「收編卡」（釘住時 hover 停用，相鄰草稿不會互搶；不 preventDefault，照樣能點進去改字）
    if (m.state === "draft" && !el.__ccmDraftBound) {
      el.__ccmDraftBound = true;
      el.addEventListener("click", () => { const mm = el.__ccmMark; if (mm && mm.state === "draft" && hasDecoration(el)) pinBubble(el, mm); });
    }
  } else if (m.state === "todo") {
    anchor.addEventListener("click", (e) => { e.stopPropagation(); openEdit(m, anchor); });
  } else if (m.state === "review") {
    // 綠色待審：點一下釘住提案卡（釘住時 hover 停用，滑鼠可安穩移去按 ✅/↩，不被相鄰標記搶走）
    anchor.title = "點一下打開提案卡（可穩定按 ✅／↩）";
    anchor.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); pinBubble(anchor, m); });
  }
  attachBubble(anchor, m);
}

function buildBubbleDOM(m, anchorEl) {
  const b = document.createElement("div");
  b.className = "ccm-bubble" + (m.state === "review" ? " review" : "") + (m.state === "draft" ? " draft" : (m.inline ? " inline" : ""));
  if (m.state === "draft") {
    b.innerHTML = `<div class="ccm-lbl">草稿・待收編</div><div class="ccm-ins"></div>` +
      `<div class="ccm-bactions"><button class="ccm-acc">✅ 收編完成（清掉標記）</button></div>`;
    b.querySelector(".ccm-ins").textContent = "CC 起草的 #cc草稿。改寫成你的話後按這裡清標記（轉 Hugo 前要清空）";
    b.querySelector(".ccm-acc").onclick = (e) => { e.stopPropagation(); clearDraftTag(m); };
  } else if (m.inline) {
    b.innerHTML = `<div class="ccm-lbl">定稿・你已改</div><div class="ccm-ins"></div>` +
      `<div class="ccm-bactions"><button class="ccm-acc">🧹 清掉標記</button></div>`;
    b.querySelector(".ccm-ins").textContent = m.instruction;
    b.querySelector(".ccm-acc").onclick = (e) => { e.stopPropagation(); clearInlineTag(m); };
  } else if (m.state === "review") {
    const isNote = m.intent === "查" || m.intent === "議";
    const hasProp = !!m.proposal;
    let btns;
    if (!isNote) {
      btns = `<button class="ccm-acc">✅ 接受</button><button class="ccm-ret">↩ 退回</button>`;
    } else if (hasProp) {   // 查/議 附了整合版 → 一鍵套用，免再等 CC
      btns = `<button class="ccm-acc">✅ 套用整合版</button><button class="ccm-clear">完成·不改</button><button class="ccm-ret">↩ 退回</button>`;
    } else {   // 只有意見、沒整合版 → 可轉 CC 改寫
      btns = `<button class="ccm-acc">✅ 完成</button><button class="ccm-improve" title="轉成待處理，交給 CC 把來源/建議寫進這句（要再等 CC 一趟）">✎ 交CC改寫</button><button class="ccm-ret">↩ 退回</button>`;
    }
    b.innerHTML = `<div class="ccm-lbl">${m.intent}・待審</div><div class="ccm-diff"></div><div class="ccm-bactions">${btns}</div>`;
    const diff = b.querySelector(".ccm-diff");
    const row = (cls, tag, text) => {
      const d = document.createElement("div"); d.className = "ccm-drow " + cls;
      const t = document.createElement("span"); t.className = "ccm-dtag"; t.textContent = tag;
      const c = document.createElement("span"); c.className = "ccm-dtext"; c.textContent = text;
      d.appendChild(t); d.appendChild(c); return d;
    };
    if (!isNote) {
      if (m.intent === "潤" && m.proposal) { if (m.quote) diff.appendChild(row("old", "原文", m.quote)); diff.appendChild(row("new", "改為", m.proposal)); }
      else if (m.intent === "接" && m.proposal) { diff.appendChild(row("new", "新增", m.proposal)); }
      else { if (m.quote) diff.appendChild(row("old", "原文", m.quote)); diff.appendChild(row("note", "說明", m.note || m.proposal || "(無內容)")); }
    } else {   // 查/議：原文 + 查證/建議意見 +（若有）整合版
      if (m.quote) diff.appendChild(row("old", "原文", m.quote));
      diff.appendChild(row("note", m.intent === "查" ? "查證" : "建議", m.note || "(無內容)"));
      if (hasProp) diff.appendChild(row("new", "套用後", m.proposal));
    }
    const acc = b.querySelector(".ccm-acc");
    if (!isNote) acc.onclick = (e) => { e.stopPropagation(); acceptMark(m); };
    else if (hasProp) acc.onclick = (e) => { e.stopPropagation(); acceptMark(m, "apply"); };
    else acc.onclick = (e) => { e.stopPropagation(); acceptMark(m, "clear"); };
    b.querySelector(".ccm-ret").onclick = (e) => { e.stopPropagation(); openEdit(m, anchorEl); };
    const clr = b.querySelector(".ccm-clear"); if (clr) clr.onclick = (e) => { e.stopPropagation(); acceptMark(m, "clear"); };
    const imp = b.querySelector(".ccm-improve");
    if (imp) imp.onclick = (e) => {
      e.stopPropagation();
      const src = (m.note || m.proposal || "").trim();   // 把 CC 查到的來源/建議塞進指令，轉潤稿後 CC 才不會又要重查
      const seed = (m.intent === "查" ? "把查證到的來源整合進這句：" : "照這個建議把這句改寫：") + src;
      openEdit(m, anchorEl, { intent: "潤", seed, ref: "" });
    };
  } else {
    b.innerHTML = `<div class="ccm-lbl">${m.intent}・待CC</div><div class="ccm-ins"></div>` +
      `<div class="ccm-bactions"><button class="ccm-bedit">編輯</button><button class="ccm-bdel">刪除</button></div>`;
    b.querySelector(".ccm-ins").textContent = m.instruction || "(無指令)";
    b.querySelector(".ccm-bedit").onclick = (e) => { e.stopPropagation(); openEdit(m, anchorEl); };
    b.querySelector(".ccm-bdel").onclick = (e) => { e.stopPropagation(); deleteMark(m.childUid); };
  }
  return b;
}
// 泡泡永遠只留一顆（singleton）：滑到新標記＝舊泡泡即刻收掉，徹底避免上下相鄰標記兩顆疊在一起
function hasDecoration(el) {
  return !!(el && el.classList && (
    el.classList.contains("ccm-underline-review") || el.classList.contains("ccm-block-flag-review") ||
    el.classList.contains("ccm-underline") || el.classList.contains("ccm-block-flag") ||
    el.classList.contains("ccm-underline-draft") || el.classList.contains("ccm-block-flag-draft")));
}
function attachBubble(anchorEl, m) {
  anchorEl.__ccmMark = m;   // 事件觸發時才讀最新 mark（block 元素會跨重畫重用，不能靠 closure 記舊的）
  if (anchorEl.__ccmBound) return;   // 同一元素只綁一次，避免 block-flag 每次重畫累加 listener
  anchorEl.__ccmBound = true;
  anchorEl.addEventListener("mouseenter", () => {
    const mm = anchorEl.__ccmMark;
    if (mm && hasDecoration(anchorEl)) showHoverBubble(anchorEl, mm);   // 標記已清（class 不在了）就不再彈 → 杜絕接受後的鬼泡泡
  });
  anchorEl.addEventListener("mouseleave", scheduleHoverHide);
}
function showHoverBubble(anchorEl, m) {
  if (pinnedBubble) return;   // 有釘住的泡泡時，hover 完全停用（避免相鄰標記搶焦點）
  if (hoverHideT) { clearTimeout(hoverHideT); hoverHideT = null; }
  if (hoverBubble && hoverAnchor === anchorEl) return;   // 已經是這顆，不重畫
  removeHoverBubble();   // singleton：先收掉任何既有泡泡（含相鄰那顆）
  hideNavBubble();
  const b = buildBubbleDOM(m, anchorEl);
  overlayEl.appendChild(b); positionBubble(b, anchorEl);
  b.addEventListener("mouseenter", () => { if (hoverHideT) { clearTimeout(hoverHideT); hoverHideT = null; } });
  b.addEventListener("mouseleave", scheduleHoverHide);
  hoverBubble = b; hoverAnchor = anchorEl;
}
function scheduleHoverHide() {
  if (hoverHideT) clearTimeout(hoverHideT);
  hoverHideT = setTimeout(removeHoverBubble, 300);
}
function removeHoverBubble() {
  if (hoverHideT) { clearTimeout(hoverHideT); hoverHideT = null; }
  if (hoverBubble) { hoverBubble.remove(); hoverBubble = null; hoverAnchor = null; }
}
// 點一下綠色標記＝把提案卡「釘」在畫面上（放 body、不隨 overlay 重畫消失）；釘住期間 hover 停用
function pinBubble(anchorEl, m) {
  unpinBubble(); removeHoverBubble(); hideNavBubble();
  const b = buildBubbleDOM(m, anchorEl);
  b.classList.add("ccm-pinned"); b.__ccmChild = m.childUid;
  document.body.appendChild(b); positionBubble(b, anchorEl);
  pinnedBubble = b;
}
function unpinBubble() { if (pinnedBubble) { pinnedBubble.remove(); pinnedBubble = null; } }
function clearAllBubbles() { removeHoverBubble(); hideNavBubble(); unpinBubble(); }   // 開面板/接受/送出時把所有泡泡收乾淨，避免舊卡殘留
// 重畫後：釘住的標記若已消失就收掉，否則重新對位（原稿在編輯時版面會跳）
function syncPinned(desired) {
  if (!pinnedBubble) return;
  const cid = pinnedBubble.__ccmChild;
  if (!desired.some((x) => x.childUid === cid)) { unpinBubble(); return; }
  const a = document.querySelector('.ccm-underline-review[data-child="' + cid + '"]') ||
            document.querySelector('.ccm-block-flag-review[data-ccm-child="' + cid + '"]') ||
            document.querySelector('.ccm-block-flag-draft[data-ccm-child="' + cid + '"]');
  if (a) positionBubble(pinnedBubble, a);
}

// 泡泡/面板都用 translateX(-50%)，靠邊時左右會被切 → 把中心點夾在視窗內
function clampX(cx, width) {
  const half = (width || 300) / 2, m = 10;
  const lo = window.scrollX + half + m, hi = window.scrollX + window.innerWidth - half - m;
  return hi < lo ? cx : Math.max(lo, Math.min(hi, cx));
}
function positionBubble(b, anchorEl) {
  const r = anchorEl.getBoundingClientRect();
  b.style.left = clampX(r.left + window.scrollX + r.width / 2, b.offsetWidth) + "px";
  // 預設在文字上方；上方空間不足（貼近視窗頂）就翻到下方，避免泡泡被切掉
  const bh = b.offsetHeight || 96;
  if (r.top - bh - 10 < 8) { b.classList.add("ccm-below"); b.style.top = (r.bottom + window.scrollY + 6) + "px"; }
  else { b.classList.remove("ccm-below"); b.style.top = (r.top + window.scrollY - 6) + "px"; }
  // 內容很多時泡泡可能整顆頂出視窗（底部的 ✅ 套用按鈕被切掉，尤其標記在文章底部）
  // → 依實際 render 後的 rect 垂直夾回視窗內。泡泡高度已由 CSS max-height 夾到 ≤ 視窗高，故必能完整塞進 [M, vh−M]。
  const vh = window.innerHeight, M = 8;
  const rect = b.getBoundingClientRect();
  let dy = 0;
  if (rect.bottom > vh - M) dy = (vh - M) - rect.bottom;   // 超出底部 → 整顆上移
  if (rect.top + dy < M) dy = M - rect.top;                // 上移後又頂到視窗頂 → 貼齊頂端（按鈕仍在底部、看得到）
  if (dy !== 0) { b.style.top = (parseFloat(b.style.top) + dy) + "px"; b.classList.add("ccm-clamped"); }
  else b.classList.remove("ccm-clamped");
}

// ── refresh ─────────────────────────────────────────────────
function clearDecorations() {
  document.querySelectorAll(".ccm-underline, .ccm-underline-review, .ccm-underline-draft").forEach((s) => {
    const p = s.parentNode; if (!p) return;
    while (s.firstChild) p.insertBefore(s.firstChild, s);
    p.removeChild(s); p.normalize();
  });
  document.querySelectorAll(".ccm-block-flag, .ccm-block-flag-review, .ccm-block-flag-draft").forEach((e) => {
    e.classList.remove("ccm-block-flag", "ccm-block-flag-review", "ccm-block-flag-draft");
    delete e.dataset.ccmChild; delete e.dataset.state; e.__ccmMark = null;   // 清掉，鬼泡泡的 hover 讀不到舊 mark
  });
  document.querySelectorAll(".ccm-mark-row").forEach((e) => e.classList.remove("ccm-mark-row"));
  overlayEl.innerHTML = "";
  hoverBubble = null; hoverAnchor = null;   // navBubble 在 body、不在 overlay，別在這裡清（交給 syncNav）
  if (hoverHideT) { clearTimeout(hoverHideT); hoverHideT = null; }
}

// 把「標記 child block」那一列標示出來（2026-08-28 起「顯示」不再隱藏：Bear 要在 Roam 裡
// 直接看到自己寫了什麼指令。這個 class 現在只負責視覺區分，不再 display:none。
// inline 手打 tag 的不標，那是正文。）
function flagChildBlock(childUid) {
  const el = findBlockTextEl(childUid);
  if (!el) return;
  const c = el.closest(".roam-block-container") || el.closest(".rm-block");
  if (c) c.classList.add("ccm-mark-row");
}

function refreshDecorations(force) {
  if (!overlayEl) return;
  if (curtainDragging && !force) { refreshDeferred = true; return; }   // 拖曳中不跑（跨 graph 查詢會讓拖曳頓），放開後補
  // 換頁時把審稿簾還原到「這頁上次審到的那段」（本頁沒記錄就停在原位）；內容變了→進度%範圍重算
  if (curtainOn) {
    curtainRangeCache = null;
    const pg = currentOpenUid();
    if (pg && pg !== curtainPageUid) { curtainPageUid = pg; if (!restoreCurtainForPage()) setTimeout(restoreCurtainForPage, 600); }
  }
  const rows = queryMarks();
  const curPage = currentPage();
  const pageUid = curPage && curPage.uid;
  const marks = [];
  for (const [cu, pu, s, pg, ps] of rows) {
    const m = parseMark(s);
    m.childUid = cu; m.pageUid = pg;
    // 行內手打 tag（正文＋#請cc修改 在同一 block、tag 不在開頭）＝Bear 已定稿、只通知 CC 同步
    const inlineTag = !/^\s*#(?:請cc修改|cc提案|\[\[(?:請cc修改|cc提案)\]\])/.test(s);
    if (inlineTag) {
      m.inline = true; m.intent = "定稿";
      m.parentUid = cu; m.parentStr = s;   // 原稿就是 block 自己，畫在自己身上
      m.instruction = s.replace(/^[\s\S]*?#(?:請cc修改|\[\[請cc修改\]\]|cc提案|\[\[cc提案\]\])\s*/, "").trim() || "你已直接修改此段，CC 會同步回 Hugo";
    } else {
      m.parentUid = pu; m.parentStr = ps;
    }
    marks.push(m);
  }
  // #cc草稿：CC 起草待你收編的段落（不是標記 child，是正文本身）→ 也標色、進導覽、可清標記
  for (const [cu, pg, s] of queryDraftTag()) {
    marks.push({
      state: "draft", childUid: cu, pageUid: pg, inline: true, intent: "草稿",
      parentUid: cu, parentStr: s, quote: "", occurrence: 1,
      instruction: s.replace(/\s*#\[\[cc草稿\]\]/g, "").replace(/\s*#cc草稿(?![\w一-鿿])/g, "").trim() || "（CC 起草，待你改寫收編）",
    });
  }
  const desired = marks.filter((m) => findBlockTextEl(m.parentUid));
  // 本頁計數：頁 uid 對得上就用全頁數；對不上/偵測不到就退回「畫面上的底線數」→ 只要有底線就一定顯示膠囊
  const pageMatched = pageUid ? marks.filter((m) => m.pageUid === pageUid) : [];
  const counted = pageMatched.length ? pageMatched : desired;
  const todoCount = counted.filter((m) => m.state === "todo").length;
  const reviewCount = counted.filter((m) => m.state === "review").length;
  const draftCount = counted.filter((m) => m.state === "draft").length;
  const sig = desired.map((m) => m.childUid + ":" + m.state).sort().join("|");
  const cur = [];
  document.querySelectorAll(".ccm-underline, .ccm-underline-review, .ccm-underline-draft, .ccm-block-flag, .ccm-block-flag-review, .ccm-block-flag-draft")
    .forEach((e) => cur.push((e.dataset.child || e.dataset.ccmChild) + ":" + (e.dataset.state || "")));
  const same = sig === cur.sort().join("|");
  if (!force && same) { updatePill(todoCount, reviewCount, draftCount); updateReformatBtn(pageUid); syncPinned(desired); syncNav(desired); return; }

  applying = true;
  clearDecorations();
  for (const m of desired) { const el = findBlockTextEl(m.parentUid); if (el) decorateMark(el, m); if (!m.inline) flagChildBlock(m.childUid); }
  updatePill(todoCount, reviewCount, draftCount);
  updateReformatBtn(pageUid);
  syncPinned(desired); syncNav(desired);
  setTimeout(() => { applying = false; }, 0);
}
const debouncedRefresh = () => { clearTimeout(debounceTimer); debounceTimer = setTimeout(refreshDecorations, 250); };

// ── 建立 / 修改 / 刪除 / 接受 ───────────────────────────────
async function createMark(parentUid, intent, instruction, quote, occurrence, rangeUids) {
  const uid = window.roamAlphaAPI.util.generateUID();
  await window.roamAlphaAPI.createBlock({ location: { "parent-uid": parentUid, order: "last" }, block: { string: markString(intent, instruction, quote, occurrence, rangeUids), uid } });
  setTimeout(() => refreshDecorations(true), 120);
}
async function updateMark(childUid, intent, instruction, quote, occurrence) {
  try { await window.roamAlphaAPI.updateBlock({ block: { uid: childUid, string: markString(intent, instruction, quote, occurrence) } }); }
  catch (e) { console.warn("[請CC修改] update failed", e); }
  setTimeout(() => refreshDecorations(true), 120);
}
async function deleteMark(childUid) {
  try { await window.roamAlphaAPI.deleteBlock({ block: { uid: childUid } }); }
  catch (e) { console.warn("[請CC修改] delete failed", e); }
  setTimeout(() => refreshDecorations(true), 120);
}

function blockString(uid) {
  try { const r = window.roamAlphaAPI.pull("[:block/string]", [":block/uid", uid]); return r ? r[":block/string"] : ""; }
  catch (e) { return ""; }
}
function replaceNth(str, needle, repl, n) {
  if (!needle) return null;
  let idx = -1, from = 0;
  for (let i = 0; i < n; i++) { idx = str.indexOf(needle, from); if (idx === -1) return null; from = idx + needle.length; }
  return str.slice(0, idx) + repl + str.slice(idx + needle.length);
}
/** 這個 block 是不是標題（Roam heading 屬性 1–3）。0＝一般段落。 */
function blockHeading(uid) {
  try { const r = window.roamAlphaAPI.pull("[:block/heading]", [":block/uid", uid]); return (r && r[":block/heading"]) || 0; }
  catch (e) { return 0; }
}

/**
 * 標題底下第一個「正文」子 block（跳過標記 block 本身）。
 * 用在：使用者把標記標在標題那一行時，真正想改的多半是底下的內容。
 */
function firstBodyChildUid(uid) {
  try {
    const res = window.roamAlphaAPI.q(`[:find ?cu ?ord ?s :where [?b :block/uid "${uid}"] [?b :block/children ?c] [?c :block/uid ?cu] [?c :block/order ?ord] [?c :block/string ?s]]`);
    if (!res || !res.length) return null;
    const rows = res.slice().sort((a, b) => a[1] - b[1]);
    for (const r of rows) if (!/#(?:請cc修改|cc提案|cc草稿|\[\[(?:請cc修改|cc提案|cc草稿)\]\])/.test(r[2] || "")) return r[0];
    return null;
  } catch (e) { return null; }
}

function siblingAfter(uid) {
  try {
    const res = window.roamAlphaAPI.q(`[:find ?gpu ?ord :where [?b :block/uid "${uid}"] [?b :block/order ?ord] [?gp :block/children ?b] [?gp :block/uid ?gpu]]`);
    if (res && res[0]) return { parent: res[0][0], order: res[0][1] + 1 };
  } catch (e) {}
  return { parent: uid, order: 0 };
}
// ✅ 接受＝Bear 把提案套進原稿（唯一讓字進原稿的動作）
async function acceptMark(m, mode) {
  clearAllBubbles();
  try {
    const replace = mode === "apply" || (!mode && m.intent === "潤");   // 潤的✅ 或 查/議的「套用整合版」都走替換
    if (mode === "clear") {
      await window.roamAlphaAPI.deleteBlock({ block: { uid: m.childUid } });
      toast("已完成（未改字）");
    } else if (replace && m.proposal && m.rangeUids && m.rangeUids.length > 1 && !m.quote) {
      // ── 跨 block 標記（Bear 框選 A、B 因為它們在講同一件事）─────────────
      // 兩種語意，用提案裡有沒有「---」分隔線來判斷：
      //   有 N-1 條分隔線 → 各段各自替換（「這幾段語氣統一一下」）
      //   沒有分隔線     → 合併成一段（「這兩段講同一件事，併起來」）
      // ⚠️ 合併時**不刪任何 block**：其餘段改寫成可刪提示並把原文留在該行，
      //    因為 block 可能有 children，程式擅自刪會連子樹一起帶走。
      const uids = m.rangeUids;
      const parts = m.proposal.split(/\n\s*-{3,}\s*\n/).map((x) => x.trim()).filter((x) => x);
      if (parts.length === uids.length) {
        for (let i = 0; i < uids.length; i++) await window.roamAlphaAPI.updateBlock({ block: { uid: uids[i], string: parts[i] } });
        await window.roamAlphaAPI.deleteBlock({ block: { uid: m.childUid } });
        toast(`已套用：${uids.length} 段各自替換`);
      } else {
        await window.roamAlphaAPI.updateBlock({ block: { uid: uids[0], string: m.proposal } });
        for (let i = 1; i < uids.length; i++) {
          const old = blockString(uids[i]);
          await window.roamAlphaAPI.updateBlock({ block: { uid: uids[i], string: "🗑 已併入上一段（確認後請自行刪除）｜原文：" + old } });
        }
        await window.roamAlphaAPI.deleteBlock({ block: { uid: m.childUid } });
        toast(`已合併進第 1 段；其餘 ${uids.length - 1} 段標成可刪（原文留在該行，沒有刪掉任何 block）`);
      }
    } else if (replace && m.proposal) {
      const curStr = blockString(m.parentUid);
      let next;
      if (m.quote) { next = replaceNth(curStr, m.quote, m.proposal, m.occurrence); if (next === null) return toast("找不到原文，未套用（原稿可能已被改）"); }
      else next = m.proposal;
      await window.roamAlphaAPI.updateBlock({ block: { uid: m.parentUid, string: next } });
      await window.roamAlphaAPI.deleteBlock({ block: { uid: m.childUid } });
      toast("已接受並套用");
    } else if (!mode && m.intent === "接" && m.proposal) {
      // 標記掛在標題上時，草稿要落在「那一節的最後」。插在標題的兄弟位置會掉到整節外面，
      // 跟後面的小節平起平坐（2026-08-28 實際踩過：三段草稿全部插錯層）。
      const pos = blockHeading(m.parentUid) > 0
        ? { parent: m.parentUid, order: "last" }
        : siblingAfter(m.parentUid);
      await window.roamAlphaAPI.createBlock({ location: { "parent-uid": pos.parent, order: pos.order }, block: { string: m.proposal + " #" + DRAFT_TAG } });
      await window.roamAlphaAPI.deleteBlock({ block: { uid: m.childUid } });
      toast("已插入草稿（掛 #cc草稿，記得改寫收編）");
    } else {
      await window.roamAlphaAPI.deleteBlock({ block: { uid: m.childUid } });
      toast("已標記完成");
    }
  } catch (e) { console.warn("[請CC修改] accept failed", e); toast("套用失敗（見 Console）"); }
  setTimeout(() => refreshDecorations(true), 120);
}

// ✅ 收編完成：清掉 #cc草稿 tag（Bear 已把草稿改寫成自己的話；正文保留，只拿掉 tag）
async function clearDraftTag(m) {
  try {
    const cur = blockString(m.childUid);
    // 中文字後面 \b 永不成立 → 改用「後面不接中文/字母」的 lookahead 才清得掉
    const next = cur.replace(/\s*#\[\[cc草稿\]\]/g, "").replace(/\s*#cc草稿(?![\w一-鿿])/g, "").trim();
    await window.roamAlphaAPI.updateBlock({ block: { uid: m.childUid, string: next } });
    toast("已收編（清掉 #cc草稿）");
  } catch (e) { console.warn("[請CC修改] clearDraftTag failed", e); toast("清除失敗（見 Console）"); }
  setTimeout(() => refreshDecorations(true), 120);
}

// 🧹 清掉行內手打的 #請cc修改（Bear 已定稿：只移除 tag＋其後通知字，正文一字不動）
async function clearInlineTag(m) {
  try {
    const cur = blockString(m.childUid);
    const next = cur.replace(/\s*#(?:請cc修改|\[\[請cc修改\]\]|cc提案|\[\[cc提案\]\])[^\n]*$/, "").trim();
    await window.roamAlphaAPI.updateBlock({ block: { uid: m.childUid, string: next } });
    toast("已清掉行內標記（正文保留）");
  } catch (e) { console.warn("[請CC修改] clearInlineTag failed", e); toast("清除失敗（見 Console）"); }
  setTimeout(() => refreshDecorations(true), 120);
}

// ── Roam 的 block 多選（藍底）──────────────────────────────
// 為什麼需要這段：Roam 在「跨 block 拖曳」的當下會接管選取，改成它自己的
// block 多選（藍底），同時把瀏覽器原生 selection 清掉。所以 window.getSelection()
// 會是 collapsed → captureSelection 直接 return null → 小鈕不會出現。
// 底下三層防禦，並在 Console 印出實際生效的來源，方便日後 Roam 改版時追。
function roamMultiSelectUids() {
  // (1) 官方 API（若這版 Roam 有提供，最可靠，不受 class 改名影響）
  try {
    const api = window.roamAlphaAPI && window.roamAlphaAPI.ui;
    const cands = [api && api.individualMultiselect, api && api.multiselect];
    for (const ms of cands) {
      if (ms && typeof ms.getSelectedUids === "function") {
        const uids = ms.getSelectedUids();
        if (Array.isArray(uids) && uids.length) {
          if (roamMultiSelectUids._src !== "api") { console.log("[請CC修改] 多選來源＝roamAlphaAPI.ui.*.getSelectedUids()"); roamMultiSelectUids._src = "api"; }
          return uids.filter(Boolean);
        }
      }
    }
  } catch (e) {}
  // (2) DOM fallback：掃 Roam 標為已選取的 block（多候選，Roam 改版時仍可能命中其一）
  const SELECTORS = [
    ".block-highlight-blue",
    ".roam-block-container.block-highlight-blue",
    ".rm-block--selected",
    "[data-block-selected='true']",
    ".block-highlight-grey",
  ];
  for (const sel of SELECTORS) {
    let nodes = [];
    try { nodes = Array.from(document.querySelectorAll(sel)); } catch (e) { continue; }
    if (!nodes.length) continue;
    const uids = [];
    for (const el of nodes) {
      let u = uidFromId(el);
      if (!u) { const inner = el.querySelector('.rm-block-text, .roam-block, [id^="block-input"]'); if (inner) u = uidFromId(inner); }
      if (u && !uids.includes(u)) uids.push(u);
    }
    if (uids.length) {
      if (roamMultiSelectUids._src !== sel) { console.log("[請CC修改] 多選來源＝DOM selector", sel, "→", uids.length, "個 block"); roamMultiSelectUids._src = sel; }
      return uids;
    }
  }
  return [];
}
// 多選時原生 selection 是空的，取第一個被選中 block 的位置當小鈕錨點
function roamMultiSelectRect() {
  const uids = roamMultiSelectUids();
  if (!uids.length) return null;
  const el = findBlockTextEl(uids[0]);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return (r.width || r.height) ? r : null;
}

// ── 擷取選取 ─────────────────────────────────────────────────
function captureSelection(allowWholeBlock) {
  const ae = document.activeElement;
  if (ae && ae.tagName === "TEXTAREA" && typeof ae.selectionStart === "number") {
    const uid = uidFromId(ae);
    if (!uid) return null;
    if (ae.selectionEnd > ae.selectionStart) {
      const quote = ae.value.substring(ae.selectionStart, ae.selectionEnd).trim();
      if (!quote) return null;
      const occ = occurrenceOf(ae.value, quote, ae.selectionStart);
      return { marks: [{ parentUid: uid, quote, occurrence: occ }], label: "「" + quote + "」" };
    }
    if (allowWholeBlock) return { marks: [{ parentUid: uid, quote: "", occurrence: 1 }], label: "（整段 block）" };
    return null;
  }
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) {
    const t = sel.toString().trim();
    if (!t) return null;
    const range = sel.getRangeAt(0);
    const startUid = getUidFromNode(range.startContainer);
    const startEl = range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer.parentElement : range.startContainer;
    if (!startUid || !startEl || !startEl.closest('.roam-block, .rm-block-text, [id^="block-input"]')) return null;
    const blocks = Array.from(document.querySelectorAll('.rm-block-text, .roam-block'))
      .filter((el) => { try { return sel.containsNode(el, true); } catch (e) { return false; } });
    const uids = [];
    for (const el of blocks) { const u = uidFromId(el); if (u && !uids.includes(u)) uids.push(u); }
    if (uids.length > 1) return { marks: [{ parentUid: uids[0], quote: "", occurrence: 1, rangeUids: uids }], label: uids.length + " 段（合為一個標記）" };
    const container = findBlockTextEl(startUid) || startEl;
    const off = offsetInContainer(container, range.startContainer, range.startOffset);
    const occ = occurrenceOf(container.textContent || "", t, off);
    return { marks: [{ parentUid: startUid, quote: t, occurrence: occ }], label: "「" + t + "」" };
  }
  // 原生 selection 沒東西 → 可能是 Roam 已接管成 block 多選（藍底），改讀它的狀態
  const multi = roamMultiSelectUids();
  if (multi.length > 1) {
    // 一個標記涵蓋整個範圍，掛在第一段底下。理由見 markString 的註解。
    return { marks: [{ parentUid: multi[0], quote: "", occurrence: 1, rangeUids: multi }], label: multi.length + " 段（合為一個標記）" };
  }
  if (multi.length === 1 && allowWholeBlock) {
    return { marks: [{ parentUid: multi[0], quote: "", occurrence: 1 }], label: "（整段 block）" };
  }
  return null;
}

function selectionRect() {
  const sel = window.getSelection();
  if (sel && sel.rangeCount && !sel.isCollapsed) {
    const r = sel.getRangeAt(0).getBoundingClientRect();
    if (r.width || r.height) return r;
  }
  return roamMultiSelectRect();   // block 多選時原生 selection 是空的
}
function markFromSelection(x, y, viaKeyboard, forceIntent) {
  const cap = captureSelection(viaKeyboard);
  if (!cap) { hidePanel(); hideTrigger(); return false; }
  // 標到「整行標題」時先問一句：多數情況要改的是底下的內容，不是標題本身。
  // 掛錯層級的後果很隱蔽——潤會改到標題、接會插到節外，所以在源頭擋。
  if (!forceIntent && cap.marks.length === 1 && !cap.marks[0].quote && blockHeading(cap.marks[0].parentUid) > 0) {
    const body = firstBodyChildUid(cap.marks[0].parentUid);
    if (body) {
      const useBody = window.confirm(
        "你標的是一行標題。\n\n要改的是「底下的內容」還是「標題本身」？\n\n" +
        "確定 ＝ 底下的內容（標記改掛到這一節的第一段）\n" +
        "取消 ＝ 標題本身"
      );
      if (useBody) { cap.marks[0].parentUid = body; cap.label = "這一節的內容（整段）"; }
    }
  }
  pending = { mode: "create", marks: cap.marks, label: cap.label };
  panelIntent = forceIntent || "潤";
  const label = forceIntent === "接" ? "（在此 block 後面插入新段）" : cap.label;
  if (viaKeyboard) { hideTrigger(); showPanel(x, y, label, ""); return true; }
  // 滑鼠：小鈕出現在「框選文字上方」（不搶焦點，避開 Roam toolbar）；點了才開面板
  const r = selectionRect();
  if (r) showTrigger(r.left + window.scrollX + r.width / 2, r.top + window.scrollY - 6);
  else showTrigger(x, y - 8);   // textarea 沒有選取 rect → 放滑鼠點上方
  return true;
}

function onMouseUp(e) {
  if (e.target && e.target.closest && e.target.closest(".ccm-bubble")) return;
  if (!active) return;
  if (panelEl && panelEl.contains(e.target)) return;
  if (triggerBtn && triggerBtn.contains(e.target)) return;
  if (fabRow && fabRow.contains(e.target)) return;
  // Roam 把跨 block 拖曳轉成 block 多選需要一點時間，10ms 沒抓到就再補一次
  setTimeout(() => {
    if (markFromSelection(e.pageX, e.pageY, false)) return;
    setTimeout(() => markFromSelection(e.pageX, e.pageY, false), 140);
  }, 10);
}
function keyboardAnchorXY() {
  const sel = window.getSelection();
  if (sel && sel.rangeCount && !sel.isCollapsed) {
    const r = sel.getRangeAt(0).getBoundingClientRect();
    if (r.width || r.height) return { x: r.left + window.scrollX + r.width / 2, y: r.bottom + window.scrollY };
  }
  const ae = document.activeElement;
  if (ae && ae.getBoundingClientRect) { const r = ae.getBoundingClientRect(); return { x: r.left + window.scrollX + Math.min(r.width / 2, 220), y: r.top + window.scrollY + 22 }; }
  return { x: window.scrollX + window.innerWidth / 2, y: window.scrollY + 200 };
}
function onKeyDown(e) {
  if (e.key === "Escape" && (pinnedBubble || navBubble)) { unpinBubble(); hideNavBubble(); return; }
  if (e.altKey && e.code === "KeyM" && !e.ctrlKey && !e.metaKey) {
    e.preventDefault(); const p = keyboardAnchorXY(); markFromSelection(p.x, p.y, true); return;
  }
  if (e.altKey && e.code === "KeyN" && !e.ctrlKey && !e.metaKey) {   // 在游標所在 block 後插入新段（接）
    e.preventDefault(); const p = keyboardAnchorXY(); markFromSelection(p.x, p.y, true, "接"); return;
  }
  if (e.altKey && (e.code === "ArrowDown" || e.code === "ArrowUp") && !e.ctrlKey && !e.metaKey) {
    if (!document.querySelector(".ccm-underline, .ccm-underline-review, .ccm-underline-draft, .ccm-block-flag, .ccm-block-flag-review, .ccm-block-flag-draft")) return;
    e.preventDefault();
    if (navEl && navEl.style.display === "none") { navEl.style.display = "flex"; navIdx = -1; }
    navGo(e.code === "ArrowDown" ? 1 : -1);
    return;
  }
  // ⌥Enter＝接受目前導覽到的待審標記並自動跳下一個；⌥R＝退回（與右下導覽列 ✅/↩ 鈕共用 navAccept/navReject）
  if (e.altKey && e.code === "Enter" && !e.ctrlKey && !e.metaKey) {
    if (navCurrent && (navCurrent.state === "review" || navCurrent.state === "draft")) { e.preventDefault(); navAccept(); }
    return;
  }
  if (e.altKey && e.code === "KeyR" && !e.ctrlKey && !e.metaKey) {
    if (navCurrent && navCurrent.state === "review") { e.preventDefault(); navReject(); }
    return;
  }
}

// ── 面板 ─────────────────────────────────────────────────────
// 退回／改進面板的參考列：把 CC 上一版提案（或查證/建議）帶進來，讓 Bear 對著它下第二次指令
function refText(m) {
  if (!m || m.state !== "review") return "";
  if (m.proposal) return "上一版 CC 提案：「" + m.proposal + "」";
  if (m.note) return "CC " + (m.intent === "查" ? "查證" : "建議") + "：" + m.note;
  return "";
}
function openEdit(m, anchorEl, opts) {
  clearAllBubbles();
  pending = { mode: "edit", childUid: m.childUid, quote: m.quote, occurrence: m.occurrence };
  panelIntent = (opts && opts.intent) || m.intent;
  const el = anchorEl || findBlockTextEl(m.parentUid);
  const r = el ? el.getBoundingClientRect() : { left: window.innerWidth / 2, bottom: 200, width: 0 };
  const prefill = (opts && opts.seed != null) ? opts.seed : m.instruction;
  const ref = (opts && typeof opts.ref === "string") ? opts.ref : refText(m);   // 改進這句已把來源塞進 seed，就不重複顯示
  showPanel(r.left + window.scrollX + r.width / 2, r.bottom + window.scrollY, m.quote ? "「" + m.quote + "」" : "（整段）", prefill, ref);
}
function setIntent(it) {
  if (!INTENTS.includes(it)) return;
  panelIntent = it;
  panelEl.querySelectorAll(".ccm-intents button").forEach((btn) => btn.classList.toggle("on", btn.dataset.intent === it));
  panelEl.querySelector(".ccm-hint").textContent = INTENT_HINT[it];
  renderPickedLine();
  panelEl.querySelector(".ccm-chips").style.display = it === "潤" ? "flex" : "none";
}
function showTrigger(x, y) {
  triggerBtn.style.display = "flex"; triggerBtn.style.left = clampX(x, triggerBtn.offsetWidth) + "px"; triggerBtn.style.top = y + "px";
  // block 多選時，「＋新段」與「📷加照片」只吃 marks[0]（單一 block 語意），
  // 顯示出來會讓人以為對全部選取生效 → 多選時直接藏掉，只留「請CC修改」。
  const n = (pending && pending.marks && pending.marks.length) || 1;
  const multi = n > 1;
  const ins = triggerBtn.querySelector(".ccm-trig-insert");
  const pho = triggerBtn.querySelector(".ccm-trig-photo");
  if (ins) ins.style.display = multi ? "none" : "";
  if (pho) pho.style.display = multi ? "none" : "";
}
function hideTrigger() { if (triggerBtn) triggerBtn.style.display = "none"; }

// ── 面板的「目標行」：這次到底要改片段還是整段（2026-09-07）──────────────
// 為什麼要做：Bear 點了「＋新段」（整段操作）之後，在面板上把意圖改成「潤」，
// 於是原本選取的那段字被丟掉、變成整段潤稿——中間沒有任何訊號，他連中兩次。
// 根因不是「意圖選錯」，是「目標被換掉而沒有提示」。所以這裡不擋、不問，只把
// 真實目標一直顯示在面板上，而且**跟著意圖即時重算**（切到潤就會亮警示）。
function renderPickedLine() {
  const el = panelEl && panelEl.querySelector(".ccm-picked");
  if (!el || !pending) return;
  const marks = pending.mode === "edit" ? [{ quote: pending.quote }] : (pending.marks || []);
  const n = marks.length;
  const withQuote = marks.filter((m) => m && m.quote);
  el.classList.remove("ccm-picked-warn");
  if (withQuote.length === n && n > 0) {                       // 有選取片段：正常
    const q = withQuote[0].quote;
    el.textContent = n > 1 ? `✂️ 只改這 ${n} 處選取的字` : `✂️ 只改：「${q}」`;
    return;
  }
  if (panelIntent === "接") {                                   // 整段＋接＝本來就該這樣，不用警示
    el.textContent = n > 1 ? `＋ 在這 ${n} 個 block 後面各插入新段` : "＋ 在這個 block 後面插入新段（以整段為單位）";
    return;
  }
  el.classList.add("ccm-picked-warn");                          // 整段＋潤/查/議＝多半不是本意
  el.textContent = n > 1
    ? `⚠️ 這 ${n} 段都會被當成「整段」處理，不是你選取的字`
    : "⚠️ 這是「整段 block」，不是你選取的某段字——要只改某一句，取消後重新選字再按「✏️ 請CC修改」";
}

function showPanel(x, y, label, prefill, ref) {
  const isEdit = pending && pending.mode === "edit";
  panelEl.querySelector(".ccm-head").textContent = isEdit ? "✏️ 修改標記" : "✏️ 請CC修改";
  panelEl.querySelector(".ccm-picked").textContent = label;
  renderPickedLine();   // 用 pending 的實際內容覆蓋 label（label 只是後備）
  const refEl = panelEl.querySelector(".ccm-ref");
  if (ref) { refEl.textContent = ref; refEl.style.display = "block"; } else { refEl.textContent = ""; refEl.style.display = "none"; }
  panelEl.querySelector(".ccm-delete").style.display = isEdit ? "inline-block" : "none";
  setIntent(panelIntent);
  const ta = panelEl.querySelector("textarea");
  ta.value = prefill || "";
  panelEl.style.display = "block";
  panelEl.style.left = clampX(x, panelEl.offsetWidth || 300) + "px"; panelEl.style.top = (y + 12) + "px";
  setTimeout(() => { ta.focus(); ta.select(); }, 0);
}
function hidePanel() { if (panelEl) panelEl.style.display = "none"; pending = null; }
async function submitPanel() {
  const ta = panelEl.querySelector("textarea");
  const ins = ta.value.trim();
  const p = pending;
  if (!p) return hidePanel();
  try { window.getSelection().removeAllRanges(); } catch (e) {}
  hidePanel(); clearAllBubbles();
  if (p.mode === "edit") await updateMark(p.childUid, panelIntent, ins, p.quote, p.occurrence);
  else for (const m of p.marks) await createMark(m.parentUid, panelIntent, ins, m.quote, m.occurrence, m.rangeUids);
}

// ── 打包本頁「待處理」給 CC ─────────────────────────────────
function queryPageTodo(pageUid) {
  try {
    const q = `[:find ?cu ?cs ?pu ?ps :where
      [?t :node/title "${TODO_TAG}"] [?c :block/refs ?t] [?c :block/uid ?cu] [?c :block/string ?cs]
      [?p :block/children ?c] [?p :block/uid ?pu] [?p :block/string ?ps]
      [?p :block/page ?pg] [?pg :block/uid "${pageUid}"]]`;
    return window.roamAlphaAPI.q(q) || [];
  } catch (e) { console.warn(e); return []; }
}
async function copyMarksPrompt() {
  const pg = currentPage(); if (!pg) return toast("找不到目前頁面");
  const rows = queryPageTodo(pg.uid);
  if (!rows.length) return toast("本頁沒有待處理標記");
  const lines = rows.map(([cu, cs, pu, ps], i) => {
    const m = parseMark(cs);
    const where = m.quote ? `原文第${m.occurrence}處「${m.quote}」` : "整段";
    return `${i + 1}. [原稿 ${pu} · 標記 ${cu}] ${m.intent}｜指令：${m.instruction || "(無)"}｜${where}\n   目前內容：${ps}`;
  });
  const text =
    `【請CC修改 · 改稿任務】\n` +
    `行為法典（第一步務必讀）：本機 /Users/tsaojian-hsiung/Desktop/Claude Code專用檔/roam-cc-mark/PROTOCOL.md（備援 raw：https://raw.githubusercontent.com/agoodbear/roam-cc-mark/main/PROTOCOL.md）\n` +
    `對象：Roam page「${pg.title}」（page uid: ${pg.uid}）\n\n` +
    `步驟：\n` +
    `1. 讀上面 PROTOCOL.md（鐵律：不得改任何原稿 block、不得刪標記、只回寫提案）。\n` +
    `2. 用 Roam MCP 讀整頁 ${pg.uid} 掌握上下文與背景（頁內若有「素材/背景」區一併讀）；要更多來龍去脈可查 Supabase handovers 最近幾筆（找這篇的紀錄）。\n` +
    `3. 逐處依「意圖」在該『標記 block』（uid 見每行的「標記」）回寫：潤=【提案】替換文／接=【提案】草稿／查議=【備註】結果＋來源，並把該標記 tag 由 #請cc修改 改成 #cc提案。原稿 block 一字不動。\n` +
    `4. 在 chat 回一份對帳清單（一處一行）。\n\n` +
    `共 ${rows.length} 個待處理標記：\n` + lines.join("\n");
  try { await navigator.clipboard.writeText(text); toast(`已複製本頁 ${rows.length} 個待處理標記給 CC`); }
  catch (e) { console.warn(e); toast("複製失敗（剪貼簿權限）"); }
}
// ── 打包「轉 Hugo 成稿」任務給新開的 Claude Code ──────────────
function countTagOnPage(tag, pageUid) {
  try {
    const r = window.roamAlphaAPI.q(
      `[:find (count ?c) :where [?t :node/title "${tag}"] [?c :block/refs ?t] [?c :block/page ?pg] [?pg :block/uid "${pageUid}"]]`);
    return (r && r[0] && r[0][0]) || 0;
  } catch (e) { return 0; }
}
// 「真標記」計數：#請cc修改/#cc提案 的真標記一定是「有文字父 block 的子 block」（extension 建的 child mark）。
// 跟顯示層 queryByTag 一致，排除「說明文字裡順口提到 tag」的頂層 block（如 boilerplate「改稿方式…#請cc修改」）——那不是待處理標記、不該擋住重排/轉Hugo。
// 2026-07-19 live 驗：本頁 :block/page 計數=1(誤含 boilerplate)、require-parent=0(＝pill 顯示)。草稿不走這個（草稿可頂層、要算），維持 countTagOnPage。
function countMarkTag(tag, pageUid) {
  try {
    const r = window.roamAlphaAPI.q(
      `[:find (count ?c) :where [?t :node/title "${tag}"] [?c :block/refs ?t] [?c :block/page ?pg] [?pg :block/uid "${pageUid}"] [?parent :block/children ?c] [?parent :block/string ?ps]]`);
    return (r && r[0] && r[0][0]) || 0;
  } catch (e) { return 0; }
}
async function copyHugoPrompt() {
  const pg = currentPage(); if (!pg) return toast("找不到目前頁面");
  const todo = countMarkTag(TODO_TAG, pg.uid) + countMarkTag(PROP_TAG, pg.uid);
  const draft = countTagOnPage(DRAFT_TAG, pg.uid);
  // 第三個歸零（2026-09-07 補）：PROTOCOL §七 早就寫了三條，這支打包只檢查兩條，
  // 於是頁上還掛著未套用的排版提案時，頭上照樣印「已雙歸零，可轉」——版面還沒定就把稿送去轉。
  const layoutPending = queryReformatProposal(pg.uid) ? 1 : 0;
  const ready = todo === 0 && draft === 0 && layoutPending === 0;
  const text =
    `【轉 Hugo · 成稿任務】\n` +
    `行為法典（第一步務必讀）：\n` +
    `  1. 本機 /Users/tsaojian-hsiung/Desktop/Claude Code專用檔/roam-cc-mark/PROTOCOL.md（§七 轉 Hugo 三個歸零＋§八 聲音守則；備援 raw：https://raw.githubusercontent.com/agoodbear/roam-cc-mark/main/PROTOCOL.md）\n` +
    `  2. 照片解析：本機 /Users/tsaojian-hsiung/Desktop/Claude Code專用檔/blog-composer/ROAM-REFS.md\n` +
    `對象：Roam page「${pg.title}」（page uid: ${pg.uid}）\n` +
    `本頁狀態：待處理／待審標記 ${todo}、#cc草稿 ${draft}、未處理的排版提案 ${layoutPending}${ready ? "（已三歸零，可轉）" : "（未歸零，請先擋下並列出）"}\n\n` +
    `步驟：\n` +
    `1. 讀上面兩份法典。\n` +
    `2. 用 Roam MCP 讀整頁 ${pg.uid}（含所有 block；素材／背景子樹一併看，轉稿時排除）。\n` +
    `3. 檢查三個歸零：① #請cc修改／#cc提案 標記＝0 ② #cc草稿＝0 ③ #cc排版提案＝0（版面還沒定就別轉）。不滿足→列出擋下、不轉。\n` +
    `4. 照片：抓草稿裡所有 composer.agoodbear.com/r/<refId> → POST http://localhost:8765/api/roam-ref-fetch {"refIds":[…]} 換原檔 → 走 Hugo 媒材管線（照片縮 1600、HEIC→JPG 驗方向、影片有 trim 裁該段 1080p+poster、PDF 拆解）。\n` +
    `5. 產 content/posts/<type>-post-N.md（Hugo 禁 H1；沿用 ecg／study／travel／erlife-post-N 慣例；跑 zhtw-mcp lint；#cc草稿 出身段落過 /de-ai-zhtw，Bear 原文不進）。\n` +
    `6. Bear review → 部署草稿 → 回 Roam 頁首寫「✅ 已發佈 → <url> <日期>」。\n` +
    `（更多脈絡：查 Supabase handovers 最近幾筆這篇的紀錄；遵守 bundle_hugo_blog_ops。）`;
  try { await navigator.clipboard.writeText(text); toast(ready ? "已複製「轉 Hugo」任務 ✅ 本頁已三歸零，貼到新的 CC session" : `已複製「轉 Hugo」任務（還有 ${todo} 標記／${draft} 草稿／${layoutPending} 個排版提案未清，CC 會擋下）`); }
  catch (e) { console.warn(e); toast("複製失敗（剪貼簿權限）"); }
}

// ── 整篇重排版（reformat）：打包給 CC 依內容重排（只動版面、不改一個字）──────────
// 混合路線：CC 出「提案樹」（隔離、帶身分），extension 做零位移驗證＋原子套用＋備份。
// 安全模型同 acceptMark：套用是 Bear 按的（extension＝Bear 的手），驗不過就鎖死套用鈕（fail-closed）。

// 素材/🗄備份/#cc排版提案/「✅ 已發佈」＝重排不碰的特殊 top-level root，攤平正文時整棵略過
function isReformatExcludedRoot(str) {
  const s = (str || "").trim();
  return /^🗂/.test(s) ||                                       // 🗂 素材／背景子樹
    /^🗄/.test(s) ||                                            // 🗄 排版前備份／還原前狀態子樹
    /#cc排版備份/.test(s) || /#\[\[cc排版備份\]\]/.test(s) ||    // #cc排版備份 root（🗄 被手動去掉也擋）
    /#cc排版提案/.test(s) || /#\[\[cc排版提案\]\]/.test(s) ||    // #cc排版提案 root
    /^✅\s*已發佈/.test(s);                                     // ✅ 已發佈 封存行
}
// 頁面 top-level 正文樹 → 深度優先攤平成字串陣列（過濾特殊 root）。v9 驗證器用；v10 保留給稽核
function gatherBodyBlocks(pageUid) {
  let tree;
  try { tree = window.roamAlphaAPI.pull("[:block/uid :block/string :block/order {:block/children ...}]", [":block/uid", pageUid]); }
  catch (e) { console.warn("[請CC修改] gatherBodyBlocks pull failed", e); return []; }
  const out = [];
  const sortKids = (n) => ((n && n[":block/children"]) || []).slice().sort((a, b) => (a[":block/order"] || 0) - (b[":block/order"] || 0));
  const walk = (n) => { out.push(n[":block/string"] || ""); for (const k of sortKids(n)) walk(k); };
  for (const t of sortKids(tree)) { if (isReformatExcludedRoot(t[":block/string"])) continue; walk(t); }
  return out;
}

// ── v10 ─────────────────────────────────────────────────────────────────
// atom＝「非正文但混在正文層裡」的 block（任意深度的 🗂／🗄／#cc排版備份）。
// 2026-09-07：版次表從 top-level 搬進稿底下之後，只看 top-level 的排除規則就不夠了。
// atom 與其子孫不進 body、提案不准引用、跟著父層走；Phase 1 把明列子層 move 到 last，atom 自然留最前。
function isReformatAtom(str) {
  const s = (str || "").trim();
  return /^🗂/.test(s) || /^🗄/.test(s) || /#cc排版備份/.test(s) || /#\[\[cc排版備份\]\]/.test(s);
}
// v10 的正文結構：Map<uid,{string,parentUid,childUids,heading,order}> ＋ atom 集合 ＋ 頁層排除 root
function gatherBodyStruct(pageUid) {
  const body = new Map(), atomIds = new Set(), topLevel = [], excludedRoots = [];
  let tree;
  try { tree = window.roamAlphaAPI.pull("[:block/uid :block/string :block/order :block/heading {:block/children ...}]", [":block/uid", pageUid]); }
  catch (e) { console.warn("[請CC修改] gatherBodyStruct pull failed", e); return { body, atomIds, topLevel, excludedRoots }; }
  const sortKids = (n) => ((n && n[":block/children"]) || []).slice().sort((a, b) => (a[":block/order"] || 0) - (b[":block/order"] || 0));
  const markAtom = (n) => { atomIds.add(n[":block/uid"]); for (const k of sortKids(n)) markAtom(k); };
  const walk = (n, parentUid) => {
    for (const k of sortKids(n)) {
      const s = k[":block/string"] || "";
      if (isReformatAtom(s)) { markAtom(k); continue; }
      body.set(k[":block/uid"], {
        string: s, parentUid, heading: k[":block/heading"], order: k[":block/order"] || 0,
        childUids: sortKids(k).filter((c) => !isReformatAtom(c[":block/string"] || "")).map((c) => c[":block/uid"]),
      });
      walk(k, k[":block/uid"]);
    }
  };
  for (const t of sortKids(tree)) {
    const s = t[":block/string"] || "";
    if (isReformatExcludedRoot(s)) { excludedRoots.push(t[":block/uid"]); if (isReformatAtom(s)) markAtom(t); continue; }
    topLevel.push(t[":block/uid"]);
    body.set(t[":block/uid"], {
      string: s, parentUid: pageUid, heading: t[":block/heading"], order: t[":block/order"] || 0,
      childUids: sortKids(t).filter((c) => !isReformatAtom(c[":block/string"] || "")).map((c) => c[":block/uid"]),
    });
    walk(t, t[":block/uid"]);
  }
  return { body, atomIds, topLevel, excludedRoots };
}
// R＝本頁被其他 block 引用的集合（排除提案子樹自己發出的 ((uid))）。這些是石頭：只准整段搬。
function inboundRefs(pageUid, proposalRootUid) {
  const out = new Set();
  try {
    const rows = window.roamAlphaAPI.q(
      `[:find ?tgt ?src :where [?t :block/page ?pg] [?pg :block/uid "${pageUid}"] [?t :block/uid ?tgt]
        [?s :block/refs ?t] [?s :block/uid ?src]]`) || [];
    const inProposal = new Set();
    if (proposalRootUid) {
      const pt = window.roamAlphaAPI.pull("[:block/uid {:block/children ...}]", [":block/uid", proposalRootUid]);
      (function w(n) { if (!n) return; inProposal.add(n[":block/uid"]); for (const k of (n[":block/children"] || [])) w(k); })(pt);
    }
    for (const [tgt, src] of rows) if (!inProposal.has(src)) out.add(tgt);
  } catch (e) { console.warn("[請CC修改] inboundRefs failed", e); }
  return out;
}
// 現有正文 top-level blocks（排除特殊 root）→ [{uid, order}]，套用時整棵搬進備份。與 gatherBodyBlocks 共用過濾
function topLevelBodyUids(pageUid) {
  let tree;
  try { tree = window.roamAlphaAPI.pull("[{:block/children [:block/uid :block/string :block/order]}]", [":block/uid", pageUid]); }
  catch (e) { console.warn("[請CC修改] topLevelBodyUids pull failed", e); return []; }
  const top = ((tree && tree[":block/children"]) || []).slice().sort((a, b) => (a[":block/order"] || 0) - (b[":block/order"] || 0));
  const out = [];
  for (const t of top) { if (isReformatExcludedRoot(t[":block/string"])) continue; out.push({ uid: t[":block/uid"], order: t[":block/order"] || 0 }); }
  return out;
}
// 頁上是否有「✅ 已發佈」封存行（top-level）→ 已封存頁擋下重排
function pageHasPublished(pageUid) {
  try {
    const tree = window.roamAlphaAPI.pull("[{:block/children [:block/string]}]", [":block/uid", pageUid]);
    return ((tree && tree[":block/children"]) || []).some((k) => /^\s*✅\s*已發佈/.test(k[":block/string"] || ""));
  } catch (e) { return false; }
}
// 查本頁 #cc排版提案 root，解析【變更摘要】/【建議】/【重排結果】uid 與內容；【重排結果】子樹攤平＝待驗正文
function queryReformatProposal(pageUid) {
  let rootUid = null;
  try {
    const r = window.roamAlphaAPI.q(
      `[:find ?u :where [?t :node/title "${REFORMAT_PROP_TAG}"] [?c :block/refs ?t] [?c :block/uid ?u] [?c :block/page ?pg] [?pg :block/uid "${pageUid}"]]`) || [];
    if (r.length) rootUid = r[0][0];
  } catch (e) { console.warn("[請CC修改] queryReformatProposal failed", e); return null; }
  if (!rootUid) return null;
  let tree;
  try { tree = window.roamAlphaAPI.pull("[:block/uid :block/string :block/order {:block/children ...}]", [":block/uid", rootUid]); }
  catch (e) { return null; }
  const sortKids = (n) => ((n && n[":block/children"]) || []).slice().sort((a, b) => (a[":block/order"] || 0) - (b[":block/order"] || 0));
  const kids = sortKids(tree);
  const find = (kw) => kids.find((k) => (k[":block/string"] || "").indexOf(kw) !== -1) || null;
  const summaryNode = find("【變更摘要】"), suggestNode = find("【結構診斷】") || find("【建議】"), resultNode = find("【重排結果】");   // 【建議】＝v8 以前的舊欄名，仍認得
  const flat = [];
  if (resultNode) { const walk = (n) => { flat.push(n[":block/string"] || ""); for (const c of sortKids(n)) walk(c); }; for (const c of sortKids(resultNode)) walk(c); }
  // ── v10：把【重排結果】讀成「樹」（不是攤平），另外解析三種文字操作宣告 ──
  const planTree = resultNode
    ? sortKids(resultNode).map(function conv(n) {
        return { string: n[":block/string"] || "", uid: n[":block/uid"], children: sortKids(n).map(conv) };
      })
    : [];
  const linesOf = (kw) => {
    const node = find(kw);
    return node ? sortKids(node).map((k) => (k[":block/string"] || "").trim()).filter(Boolean) : [];
  };
  const REFX = /\(\(([A-Za-z0-9_-]{1,40})\)\)/g;
  const uidsIn = (line) => { const o = []; let m; REFX.lastIndex = 0; while ((m = REFX.exec(line))) o.push(m[1]); return o; };
  const splits = linesOf("【切分】").map((l) => {
    const us = uidsIn(l);
    if (/依換行/.test(l)) return { uid: us[0], mode: "newline", newUids: us.slice(1), raw: l };
    const m = /切點：「([\s\S]*?)」\s*‖\s*「([\s\S]*?)」/.exec(l);
    return { uid: us[0], mode: "anchor", before: m ? m[1] : "", after: m ? m[2] : "", newUids: us.slice(1), raw: l };
  }).filter((x) => x.uid);
  const merges = linesOf("【合併】").map((l) => ({
    uids: uidsIn(l),
    joiner: /接合：換行/.test(l) ? "\n" : /接合：空格/.test(l) ? " " : "",
    raw: l,
  })).filter((x) => x.uids.length >= 2);
  const bolds = linesOf("【加粗】").map((l) => {
    const us = uidsIn(l), m = /「([\s\S]*)」\s*$/.exec(l);
    return { uid: us[0], sentence: m ? m[1] : "", raw: l };
  }).filter((x) => x.uid && x.sentence);
  // v9 舊格式偵測：【重排結果】的節點若不是 ((uid))／##標題 就是副本式提案
  const isV9 = planTree.some((n) => !/^\(\([A-Za-z0-9_-]{1,40}\)\)$/.test((n.string || "").trim()) && !/^#{2,3}\s/.test((n.string || "").trim()));

  return {
    rootUid, rootStr: (tree && tree[":block/string"]) || "",
    summaryStr: summaryNode ? (summaryNode[":block/string"] || "") : "",
    suggestStr: suggestNode ? (suggestNode[":block/string"] || "") : "",
    resultUid: resultNode && resultNode[":block/uid"], resultNode, proposalTexts: flat,
    planTree, splits, merges, bolds, isV9,
  };
}
// 查本頁所有 #cc排版備份 root（正常至多一個）→ [{uid, str}]
function queryReformatBackups(pageUid) {
  try {
    return (window.roamAlphaAPI.q(
      `[:find ?u ?s :where [?t :node/title "${REFORMAT_BACKUP_TAG}"] [?c :block/refs ?t] [?c :block/uid ?u] [?c :block/string ?s] [?c :block/page ?pg] [?pg :block/uid "${pageUid}"]]`) || [])
      .map(([u, s]) => ({ uid: u, str: s }));
  } catch (e) { return []; }
}

// ── 零位移驗證（安全核心）：純函式、無 Roam 依賴，可 headless 對抗式測 ───────────
// 正規化：去 **／__（唯一允許新增的格式），所有空白壓成單一空白，去首尾空白
function normReformatText(s) {
  return (s || "").replace(/\*\*/g, "").replace(/__/g, "").replace(/\s+/g, " ").trim();
}
// 「## 」或「### 」開頭＝提案新增的標題 block（唯一合法新增）→ 比對前剔除
function isHeadingBlock(s) { return /^\s*#{2,3}\s/.test(s || ""); }

// ── 標題守衛（2026-09-07 補洞）───────────────────────────────────────────
// 洞在哪：標題 block 在「逐字比對」與「格式記號守恆」兩道檢查之前就被 filter 掉了，
// 等於 CC 可以把原稿沒有的任何字塞進 `## `，驗證器完全看不見。實測：
//   提案多一段「## 她死於心肌梗塞，就是因為那天沒有做導管」→ verifyZeroDrift 回 ok:true。
// 補法是四條，前三條機器擋，第四條靠人：
//   1) 數量上限  2) 長度上限  3) 禁記號、禁數字（醫學數字絕不走這條通道）
//   4) 卡片把每個新標題全文列出來 —— 捏造的「短標題」機器擋不住，只能靠 Bear 眼睛看。
const HEAD_MAX_LEN = 30;   // 單一標題字數上限（拿真實文章校準：「這個 case：SLE 合併 APS，TnI 顯著升高」27 字要能過）
const HEAD_MAX_N = 15;     // 全篇新標題數量上限
function checkHeadings(headTexts) {
  const errors = [];
  if (headTexts.length > HEAD_MAX_N) errors.push(`新標題 ${headTexts.length} 個，超過上限 ${HEAD_MAX_N}`);
  for (const t of headTexts) {
    if ([...t].length > HEAD_MAX_LEN) errors.push(`標題過長（${[...t].length} 字，上限 ${HEAD_MAX_LEN}）：${t}`);
    if (/\[\[|\(\(|\{\{|!\[/.test(t)) errors.push(`標題內不得出現 [[ (( {{ ![ ：${t}`);
    if (/[0-9０-９]/.test(t)) errors.push(`標題內不得出現數字：${t}`);
  }
  return { ok: errors.length === 0, errors };
}
// 守恆計數：格式記號兩側次數必一致（防「文字沒改但把 highlight／ref／圖片弄丟」）
function countReformatTokens(raw) {
  const c = (re) => (raw.match(re) || []).length;
  return {
    link: c(/\[\[[^\[\]]*\]\]/g),        // [[…]]
    blockref: c(/\(\([^()]*\)\)/g),      // ((…))
    highlight: c(/\^\^[\s\S]*?\^\^/g),   // ^^…^^
    render: c(/\{\{[^{}]*\}\}/g),        // {{…}}
    image: c(/!\[[^\]]*\]\([^()]*\)/g),  // ![…](…)
  };
}
function verifyZeroDrift(bodyTexts, proposalTexts) {
  const bodyBlocks = bodyTexts || [];
  const propBlocks = (proposalTexts || []).filter((s) => !isHeadingBlock(s));   // 剔除提案側 ##/### 標題
  const headTexts = (proposalTexts || []).filter(isHeadingBlock)
    .map((s) => s.replace(/^\s*#{2,3}\s+/, "").trim());                          // 被剔除的那些＝唯一能塞新字的通道
  const heads = checkHeadings(headTexts);
  heads.texts = headTexts;
  const bodyNorm = bodyBlocks.map(normReformatText).filter((x) => x);
  const propNorm = propBlocks.map(normReformatText).filter((x) => x);
  const A = bodyNorm.join(""), B = propNorm.join("");   // 逐字串接（禁段落搬移 → 串接比對成立）
  let textOk = A === B, firstDiff = null;
  if (!textOk) {
    let i = 0; const n = Math.min(A.length, B.length);
    while (i < n && A[i] === B[i]) i++;
    firstDiff = { pos: i, before: A.slice(Math.max(0, i - 20), i + 20), after: B.slice(Math.max(0, i - 20), i + 20) };
  }
  const bc = countReformatTokens(bodyBlocks.join("\n")), pc = countReformatTokens(propBlocks.join("\n"));
  const counts = { ok: true, body: bc, proposal: pc, diff: [] };
  for (const k of Object.keys(bc)) if (bc[k] !== pc[k]) { counts.ok = false; counts.diff.push({ kind: k, body: bc[k], proposal: pc[k] }); }
  return { ok: textOk && counts.ok && heads.ok, textOk, firstDiff, counts, heads };
}

// ── v10 安全核心：verifyReformatPlan（自 scratchpad/plan-verify.mjs 移植，26/26 對抗測試通過）──
// v10 ── verifyReformatPlan：把 CC 的「操作計畫」驗到能安全套用為止。
// 純函式、無 Roam 依賴 → headless 對抗式測試。
//
// 與 v9 最大的不同：提案樹裡**沒有 Bear 的字**，只有 ((uid)) 與 ## 標題。
// 所以「不改字」不是驗出來的，是建構出來的；這裡驗的是「結構有沒有漏、有沒有多、有沒有動到不該動的」。


const PLAN_REF_ONLY = /^\(\(([A-Za-z0-9_-]{1,40})\)\)$/;
const PLAN_HEAD_REF = /^(#{2,3})\s+\(\(([A-Za-z0-9_-]{1,40})\)\)$/;   // 「## ((uid))」＝把 Bear 自己那一句升格成標題
const PLAN_HEAD_RE  = /^(#{2,3})\s+(.*)$/;

// ── v11 標題來源三選一（2026-09-07，Bear「你排的沒有我的靈魂」的正解）────────────
// 實測：他 18 篇 ecg-post 的 241 個標題，108 個（44%）會被舊護欄（≤30 字、禁數字）擋掉，
// 被擋的正是「**Step 1:排除artifact**」「如果這時候的AIVR是115下，你還是認得出AIVR嗎?」
// 這種有靈魂的；能過的只剩「基本知識」「參考資料:」這種死標籤。他的標題是**在說話**，
// 不是目錄條目。舊護欄的用意（防 CC 把醫學數字寫進不進逐字比對的通道）是對的，
// 但正解不是放寬長度，是**斷掉 CC 造標題的權利**：
//   (a) 路標白名單 —— 唯一可以新建的標題，內容固定、不可能夾帶醫學數字
//   (b) 「## ((uid))」升格 —— 標題是 Bear 自己的 block，uid 不變、字不變、ref 不斷
//   (c) 其他一律退件
// 因此長度上限與禁數字**整組拿掉**：那兩條只在「CC 自由造句」的世界裡才有意義。
const PLAN_HEAD_MAX_N   = 15;   // 新建路標的數量上限（升格不受限，那是 Bear 自己的字）
const PLAN_BOLD_MAX_N   = 5;
const PLAN_SENT_END    = /[。！？；：!?;:.…」』）\)]/;   // 切點前最後一個非空白字必須是句末標點

// 路標白名單：取自 Bear 18 篇 ecg-post 實測（拉回個案 27 次／10 篇；收尾固定節 38 次／17 篇）
const PLAN_SIGNPOST_SRC = [
  "Case繼續", "Case個案繼續", "個案繼續", "Back to case", "再度Back to Case",
  "拉回正題", "回到正題", "回到此個案", "回到個案", "回到病人", "回到 case",
  "先問自己幾個問題", "先來幾個問題", "有幾個問題", "我列出幾個好玩的問題",
  "學習重點", "文章重點", "Learning Points", "參考資料", "參考文獻",
  "事後回顧感想", "延伸閱讀", "註釋與出處", "統整", "小結",
];
// 比對用的正規化：拿掉裝飾（** <mark> 前導 emoji 尾巴的 ~~／冒號），只留核心字。
// 只影響「比對」，建出來的標題用原字串，所以 ❤️ ~~ 這些他的招牌裝飾會照樣留著。
function planSignKey(t) {
  let s = String(t || "").replace(/<\/?mark>/gi, "").replace(/[*`]/g, "").trim();
  s = s.replace(/^[\s\u3000\u200d\ufe0f\u2190-\u21ff\u2460-\u24ff\u2600-\u27bf\u{1f000}-\u{1faff}]+/u, "");   // 前導 emoji：❤️ ↩️ 🙋 ① 等
  s = s.replace(/[~～〜\s]+$/g, "").replace(/[:：]+$/g, "");
  return s.replace(/\s+/g, "").toLowerCase();
}
const PLAN_SIGNPOSTS = new Set(PLAN_SIGNPOST_SRC.map(planSignKey));

/**
 * @param {object} ctx
 *   body    Map<uid, {string, parentUid, childUids:[], heading?}>   正文（已排除 atom 與頁層排除 root）
 *   atomIds Set<uid>            任意深度的 🗂/🗄 atom 與其子孫
 *   refd    Set<uid>            R：被引用集合（已排除提案子樹發出的引用）
 *   tree    [{string, children}] 【重排結果】的直接子層
 *   splits  [{uid, mode:'anchor'|'newline', newUids:[], before?, after?}]
 *   merges  [{uids:[survivor,...away], joiner:''|'\n'|' '}]
 *   bolds   [{uid, sentence}]
 */
function verifyReformatPlan(ctx) {
  const { body, atomIds = new Set(), refd = new Set(), tree = [],
          splits = [], merges = [], bolds = [] } = ctx;
  const errors = [];
  const E = (code, msg, extra = {}) => errors.push({ code, msg, ...extra });
  const brief = (u) => `${u}「${(body.get(u)?.string || "").replace(/\n/g, "⏎").slice(0, 12)}」`;

  // ── 先攤平提案樹，順便做 V1 / V2 ────────────────────────────────────
  const listed = [];          // [{uid, isLeaf, depth}]
  const heads  = [];          // 新建的路標標題（白名單）
  const promos = [];          // 升格：{uid, level} —— 標題是 Bear 自己的 block
  (function walk(nodes, depth) {
    for (const n of nodes) {
      const s = (n.string || "").trim();
      const mPromo = PLAN_HEAD_REF.exec(s);
      const mRef = PLAN_REF_ONLY.exec(s), mHead = PLAN_HEAD_RE.exec(s);
      if (mPromo) {                       // 「## ((uid))」＝把既有 block 升格；它仍然是正文的一段
        listed.push({ uid: mPromo[2], isLeaf: !(n.children || []).length, depth });
        promos.push({ uid: mPromo[2], level: mPromo[1].length });
      }
      else if (mRef)  listed.push({ uid: mRef[1], isLeaf: !(n.children || []).length, depth });
      else if (mHead) heads.push({ level: mHead[1].length, text: mHead[2].trim() });
      else            E("V1_FOREIGN", `提案節點不是 ((uid)) 也不是 ##/### 標題：「${s.slice(0, 30)}」`);
      walk(n.children || [], depth + 1);
    }
  })(tree, 0);

  // ── V2 標題來源三選一：路標白名單／升格 Bear 自己的句子／其他一律退件 ──────
  if (heads.length > PLAN_HEAD_MAX_N) E("V2_HEAD_MANY", `新建路標 ${heads.length} 個，上限 ${PLAN_HEAD_MAX_N}`);
  for (const h of heads) {
    if (!PLAN_SIGNPOSTS.has(planSignKey(h.text)))
      E("V2_HEAD_FREE",
        `標題不准自己造句：「${h.text}」。兩條路：① 用路標白名單（${PLAN_SIGNPOST_SRC.slice(0, 6).join("／")}…）；` +
        `② 寫「${"#".repeat(h.level)} ((uid))」把 Bear 自己寫的那一句升格成標題。`);
  }

  // ── 三種文字操作先解析出集合（V5 要用）───────────────────────────
  const newSplitUids = new Set();
  for (const sp of splits) for (const u of sp.newUids || []) newSplitUids.add(u);
  const mergedAway = new Set();
  for (const mg of merges) for (const u of (mg.uids || []).slice(1)) mergedAway.add(u);

  // 純空白且無子層 → 隱含刪除（不必宣告）
  const blanks = new Set();
  for (const [u, b] of body) if (!normReformatText(b.string) && !(b.childUids || []).length) blanks.add(u);

  // ── V3 每個引用都要指得到；V6 不准引用 atom ────────────────────────
  for (const it of listed) {
    if (atomIds.has(it.uid)) { E("V6_ATOM", `不得引用排除區（🗂/🗄）的 block：${it.uid}`, { uid: it.uid }); continue; }
    if (!body.has(it.uid) && !newSplitUids.has(it.uid))
      E("V3_UNKNOWN", `提案引用了不存在於正文的 uid：${it.uid}`, { uid: it.uid });
  }

  // ── V4 明列不得重複 ────────────────────────────────────────────────
  const seen = new Map();
  for (const it of listed) seen.set(it.uid, (seen.get(it.uid) || 0) + 1);
  for (const [u, n] of seen) if (n > 1) E("V4_DUP", `同一段在提案裡出現 ${n} 次：${brief(u)}`, { uid: u });

  // ── V5 覆蓋：明列 ∪ 葉節點隱含子樹  ==  應涵蓋集合 ────────────────
  const listedSet = new Set(listed.map((i) => i.uid));
  const covered = new Set();
  const addSubtree = (u) => {
    if (atomIds.has(u)) return;                 // atom 與其子孫不屬於正文
    if (blanks.has(u)) return;                  // 純空白 block 會在 Phase 3 被刪，不算覆蓋（否則與 expected 對不起來）
    covered.add(u);
    for (const c of body.get(u)?.childUids || []) addSubtree(c);
  };
  for (const it of listed) {
    if (!body.has(it.uid)) { covered.add(it.uid); continue; }   // 切分產生的新 uid
    if (it.isLeaf) addSubtree(it.uid);
    else {
      covered.add(it.uid);
      // 內部節點：它的子層由提案明列 → 這裡不展開；但若某個現有子層既沒被明列、
      //           也不在別處被明列，V5 的差集會抓到（就是孤兒）
    }
  }
  // 葉節點隱含展開時不得吃掉別處明列的 uid（V4 的第二半）
  for (const it of listed) {
    if (!body.has(it.uid) || !it.isLeaf) continue;
    for (const c of body.get(it.uid).childUids || [])
      (function chk(x) {
        if (listedSet.has(x)) E("V4_OVERLAP", `${brief(it.uid)} 以葉節點整棵照搬，但它的子孫 ${x} 又被單獨明列`, { uid: x });
        for (const g of body.get(x)?.childUids || []) chk(g);
      })(c);
  }

  const expected = new Set();
  for (const u of body.keys()) {
    if (atomIds.has(u) || mergedAway.has(u) || blanks.has(u)) continue;
    expected.add(u);
  }
  for (const u of newSplitUids) expected.add(u);

  for (const u of expected) if (!covered.has(u))
    E("V5_ORPHAN", `這段沒被安置（孤兒）：${brief(u)}，現在掛在 ${body.get(u)?.parentUid || "?"}`, { uid: u });
  for (const u of covered) if (!expected.has(u))
    E("V5_EXTRA", `提案多出一段：${u}`, { uid: u });

  // ── V7 被引用的段落完全不可變 ─────────────────────────────────────
  const mutated = new Set([...newSplitUids]);
  for (const sp of splits) mutated.add(sp.uid);
  for (const mg of merges) for (const u of mg.uids || []) mutated.add(u);
  for (const b of bolds) mutated.add(b.uid);
  for (const u of blanks) mutated.add(u);
  for (const u of refd) if (mutated.has(u))
    E("V7_REFD", `被其他 block 引用的段落只准整段搬，不可切/併/加粗/刪：${brief(u)}`, { uid: u });

  // ── V8 切分 ────────────────────────────────────────────────────────
  for (const sp of splits) {
    const b = body.get(sp.uid);
    if (!b) { E("V8_NO_BLOCK", `切分指向不存在的 block ${sp.uid}`); continue; }
    let pieces = null;
    if (sp.mode === "newline") {
      pieces = b.string.split("\n");
      if (pieces.length !== (sp.newUids || []).length + 1)
        E("V8_COUNT", `依換行切分：${sp.uid} 有 ${pieces.length} 段，但只宣告了 ${(sp.newUids || []).length} 個新 uid`);
    } else {
      const re = new RegExp(planEsc(sp.before) + "\\s*" + planEsc(sp.after));
      const hits = [...b.string.matchAll(new RegExp(re, "g"))];
      if (hits.length !== 1) { E("V8_ANCHOR", `切點錨點在 ${sp.uid} 命中 ${hits.length} 次（須恰好 1 次），請加長錨點`); continue; }
      const cut = hits[0].index + sp.before.length;
      // 右半片從 after 開頭算起，不是從整個 match 之後（match 把 after 也含進去了）
      const rightStart = hits[0].index + hits[0][0].length - sp.after.length;
      const left = b.string.slice(0, cut);
      const lastCh = left.replace(/\s+$/, "").slice(-1);
      const gapHasNL = /\n/.test(b.string.slice(cut, rightStart));
      if (!PLAN_SENT_END.test(lastCh) && !gapHasNL)
        E("V8_NOT_PUNCT", `切點不在句末標點也不在換行處（前一個字是「${lastCh}」）：${sp.uid}`);
      pieces = [left, b.string.slice(rightStart)];
      if ((sp.newUids || []).length !== 1)
        E("V8_COUNT", `錨點切分應宣告 1 個新 uid，實得 ${(sp.newUids || []).length}`);
    }
    if (pieces) {
      pieces.forEach((p, k) => {
        if (!normReformatText(p)) E("V8_EMPTY", `${sp.uid} 切出空片段（第 ${k + 1} 片）`);
        if (planCount(p, /\*\*/g) % 2) E("V8_UNPAIRED", `${sp.uid} 第 ${k + 1} 片的 ** 沒有成對`);
        if (planCount(p, /\^\^/g) % 2) E("V8_UNPAIRED", `${sp.uid} 第 ${k + 1} 片的 ^^ 沒有成對`);
      });
      const tot = pieces.map(planTok).reduce(planSumTok, planTok(""));
      const src = planTok(b.string);
      for (const k of Object.keys(src)) if (src[k] !== tot[k])
        E("V8_TOKEN", `${sp.uid} 切分後 ${k} 數量從 ${src[k]} 變成 ${tot[k]}（切斷了語法）`);
    }
    for (const nu of sp.newUids || []) {
      if (body.has(nu)) E("V8_UID_TAKEN", `切分要用的新 uid ${nu} 已經存在`);
      if ((seen.get(nu) || 0) !== 1) E("V8_UID_UNPLACED", `切分產生的 ${nu} 在提案樹裡出現 ${seen.get(nu) || 0} 次（須恰好 1 次）`);
    }
  }

  // ── V9 合併 ────────────────────────────────────────────────────────
  for (const mg of merges) {
    const us = mg.uids || [];
    if (us.length < 2) { E("V9_TOO_FEW", `合併至少要兩段`); continue; }
    for (const u of us) if (!body.has(u)) E("V9_NO_BLOCK", `合併指向不存在的 block ${u}`);
    const [sv, ...away] = us;
    if (!listedSet.has(sv)) E("V9_SURVIVOR_UNPLACED", `合併存活者 ${brief(sv)} 沒有出現在提案樹裡`);
    for (const u of away) {
      if (listedSet.has(u)) E("V9_AWAY_LISTED", `被合併掉的 ${brief(u)} 不該出現在提案樹裡`);
      for (const c of body.get(u)?.childUids || [])
        if (!listedSet.has(c) && !planCoveredElsewhere(c, listedSet, body))
          E("V9_AWAY_CHILD", `被合併掉的 ${brief(u)} 還有子層 ${brief(c)} 沒有被安置`);
    }
    if (!["", "\n", " "].includes(mg.joiner ?? "")) E("V9_JOINER", `接合字元只能是 無／換行／空格`);
  }

  // ── V10 加粗 ───────────────────────────────────────────────────────
  if (bolds.length > PLAN_BOLD_MAX_N) E("V10_BOLD_MANY", `加粗 ${bolds.length} 處，上限 ${PLAN_BOLD_MAX_N}`);
  for (const bd of bolds) {
    const b = body.get(bd.uid);
    if (!b) { E("V10_NO_BLOCK", `加粗指向不存在的 block ${bd.uid}`); continue; }
    const n = b.string.split(bd.sentence).length - 1;
    if (n !== 1) E("V10_NOT_UNIQUE", `加粗句在原文出現 ${n} 次（須恰好 1 次）：${bd.sentence.slice(0, 18)}`);
    if (/\*\*/.test(bd.sentence)) E("V10_NESTED", `加粗句本身已含 **：${bd.sentence.slice(0, 18)}`);
  }

  // ── V11 每個 uid 最多一種文字操作、一次 ────────────────────────────
  const opCount = new Map();
  const bump = (u) => opCount.set(u, (opCount.get(u) || 0) + 1);
  for (const sp of splits) bump(sp.uid);
  for (const mg of merges) for (const u of mg.uids || []) bump(u);
  for (const bd of bolds) bump(bd.uid);
  for (const [u, n] of opCount) if (n > 1)
    E("V11_MULTI_OP", `${brief(u)} 同時被 ${n} 種文字操作動到（切完再併這類複合操作不接）`, { uid: u });

  const stats = {
    move: listed.filter((i) => body.has(i.uid)).length,
    leafWhole: listed.filter((i) => i.isLeaf && body.has(i.uid)).length,
    heads: heads.length, headTexts: heads.map((h) => h.text),
    promote: promos.length,
    promoTexts: promos.map((pm) => `${"#".repeat(pm.level)} ${(body.get(pm.uid) || {}).string || pm.uid}`),
    split: splits.length, splitNew: newSplitUids.size,
    merge: merges.length, mergedAway: mergedAway.size,
    bold: bolds.length, blanks: blanks.size, refd: refd.size,
    bodyTotal: body.size,
  };
  return { ok: errors.length === 0, errors, stats };
}

// ── 小工具 ──
const planEsc = (s) => (s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const planCount = (s, re) => ((s || "").match(re) || []).length;
function planTok(raw) {
  const c = (re) => planCount(raw, re);
  return { link: c(/\[\[[^\[\]]*\]\]/g), blockref: c(/\(\([^()]*\)\)/g),
           highlight: c(/\^\^[\s\S]*?\^\^/g), render: c(/\{\{[^{}]*\}\}/g),
           image: c(/!\[[^\]]*\]\([^()]*\)/g) };
}
const planSumTok = (a, b) => { const o = {}; for (const k of Object.keys(a)) o[k] = a[k] + b[k]; return o; };
function planCoveredElsewhere(uid, listedSet, body) {
  // 被某個「葉節點整棵照搬」蓋到也算安置好了
  for (const u of listedSet) {
    if (!body.has(u)) continue;
    let found = false;
    (function w(x) { for (const c of body.get(x)?.childUids || []) { if (c === uid) found = true; w(c); } })(u);
    if (found) return true;
  }
  return false;
}


// ── v10：applyReformatPlan（自 scratchpad/plan-apply.mjs 移植；端到端＋中斷重跑實測通過）──
const APLAN_REF = /^\(\(([A-Za-z0-9_-]{1,40})\)\)$/;
const APLAN_HEAD = /^(#{2,3})\s+(.*)$/;
const APLAN_HEAD_REF = /^(#{2,3})\s+\(\(([A-Za-z0-9_-]{1,40})\)\)$/;   // 升格：標題就是 Bear 既有的那個 block

async function applyReformatPlan(ctx, api, log = () => {}) {
  const { body, atomIds = new Set(), refd = new Set(), tree = [], pageUid,
          splits = [], merges = [], bolds = [], excludedRoots = [], proposalRootUid = null } = ctx;
  const audit = { phase: null, created: 0, moved: 0, updated: 0, deleted: 0, errors: [] };
  const fail = (m) => { audit.errors.push(m); log("❌ " + m); };

  // ── Phase 0：切分（先建新 block，內容就位；位置留給 Phase 1）──────────
  audit.phase = 0;
  const splitPieces = new Map();                      // uid -> [片0, 片1, …]（原始字串，不是 norm）
  for (const sp of splits) {
    const cur = await api.pull(sp.uid);
    if (!cur) { fail(`切分來源不存在 ${sp.uid}`); continue; }
    const orig = body.get(sp.uid).string;
    let pieces;
    if (sp.mode === "newline") pieces = orig.split("\n");
    else {
      const re = new RegExp(planEsc(sp.before) + "\\s*" + planEsc(sp.after));
      const m = re.exec(orig);
      const cut = m.index + sp.before.length;
      const rightStart = m.index + m[0].length - sp.after.length;
      pieces = [orig.slice(0, cut), orig.slice(rightStart)];
    }
    splitPieces.set(sp.uid, pieces);
    if (cur.string === pieces[0]) { log(`↩︎ 切分 ${sp.uid} 已完成，跳過（重跑）`); continue; }
    if (cur.string !== orig) { fail(`切分守衛失敗：${sp.uid} 現況既不是前狀態也不是後狀態（有人改過）`); continue; }
    for (let k = 1; k < pieces.length; k++) {
      await api.create({ parent: pageUid, order: "last", uid: sp.newUids[k - 1], string: pieces[k] });
      audit.created++;
    }
    await api.update({ uid: sp.uid, string: pieces[0] });
    audit.updated++;
  }

  // ── Phase 1：搬移（冪等；每個 parent 依目標順序全串 move 到 last）──────
  audit.phase = 1;
  const headingCache = new Map();                     // `${parent} ${text}` -> uid
  async function layout(parentUid, nodes) {
    for (const n of nodes) {
      const s = (n.string || "").trim();
      const mRef = APLAN_REF.exec(s), mHead = APLAN_HEAD.exec(s), mPromo = APLAN_HEAD_REF.exec(s);
      if (mPromo) {                       // 升格：Bear 自己的 block 搬到位、只補 heading 屬性，字與 uid 都不動
        const uid = mPromo[2], level = mPromo[1].length;
        await api.move({ parent: parentUid, order: "last", uid });
        audit.moved++;
        const cur = await api.pull(uid);
        if (cur && (cur.heading || 0) !== level) {
          await api.update({ uid, string: cur.string, heading: level });
          audit.updated++;
        }
        if ((n.children || []).length) await layout(uid, n.children);
      } else if (mHead) {
        const level = mHead[1].length, text = mHead[2].trim();
        const key = `${parentUid} ${text}`;
        let uid = headingCache.get(key);
        if (!uid) {                                    // 重跑守衛：這個 parent 底下已經有同字同級、且不屬於正文的 block ⇒ 沿用
          const p = await api.pull(parentUid);
          for (const c of p?.childUids || []) {
            const cb = await api.pull(c);
            if (cb && cb.string === text && cb.heading === level && !body.has(c)) { uid = c; break; }
          }
        }
        if (uid) { await api.move({ parent: parentUid, order: "last", uid }); audit.moved++; }
        else {
          uid = api.newUid();
          await api.create({ parent: parentUid, order: "last", uid, string: text, heading: level });
          audit.created++;
        }
        headingCache.set(key, uid);
        if ((n.children || []).length) await layout(uid, n.children);
      } else if (mRef) {
        await api.move({ parent: parentUid, order: "last", uid: mRef[1] });
        audit.moved++;
        if ((n.children || []).length) await layout(mRef[1], n.children);
      }
    }
  }
  await layout(pageUid, tree);
  // 頁層排除 root（🗂 版次表在頁層時／🗄 備份／✅ 已發佈）依原相對順序收尾
  for (const u of excludedRoots) { await api.move({ parent: pageUid, order: "last", uid: u }); audit.moved++; }

  // ── Phase 2：會動字串的操作（每條帶守衛）───────────────────────────
  audit.phase = 2;
  for (const mg of merges) {
    const [sv, ...away] = mg.uids;
    const cur = await api.pull(sv);
    const want = mg.uids.map((u) => body.get(u).string).join(mg.joiner ?? "");
    if (cur?.string === want) { log(`↩︎ 合併 ${sv} 已完成，跳過`); continue; }
    if (cur?.string !== body.get(sv).string) { fail(`合併守衛失敗：${sv} 現況不是前狀態`); continue; }
    await api.update({ uid: sv, string: want }); audit.updated++;
  }
  for (const bd of bolds) {
    const cur = await api.pull(bd.uid);
    const want = body.get(bd.uid).string.replace(bd.sentence, "**" + bd.sentence + "**");
    if (cur?.string === want) { log(`↩︎ 加粗 ${bd.uid} 已完成，跳過`); continue; }
    if (cur?.string !== body.get(bd.uid).string) { fail(`加粗守衛失敗：${bd.uid} 現況不是前狀態`); continue; }
    await api.update({ uid: bd.uid, string: want }); audit.updated++;
  }

  // ── Phase 3：刪除（逐個斷言；提案 root 最後刪，重跑入口留到最後）────
  audit.phase = 3;
  if (audit.errors.length) { log("⚠️ 前面有錯，跳過所有刪除（正文完整，可重跑）"); return finish(); }
  const toDelete = [];
  for (const mg of merges) for (const u of mg.uids.slice(1)) toDelete.push({ uid: u, why: "合併掉" });
  for (const [u, b] of body) if (!normReformatText(b.string) && !(b.childUids || []).length) toDelete.push({ uid: u, why: "空白" });
  for (const d of toDelete) {
    const cur = await api.pull(d.uid);
    if (!cur) continue;                                   // 重跑：已刪
    if ((cur.childUids || []).length) { fail(`拒刪 ${d.uid}（${d.why}）：它還有 ${cur.childUids.length} 個子層`); continue; }
    if (refd.has(d.uid)) { fail(`拒刪 ${d.uid}（${d.why}）：它被其他 block 引用`); continue; }
    if (d.why === "空白" && normReformatText(cur.string)) { fail(`拒刪 ${d.uid}：它已經不是空白了`); continue; }
    await api.del(d.uid); audit.deleted++;
  }
  if (proposalRootUid && !audit.errors.length) { await api.del(proposalRootUid); audit.deleted++; }

  // ── Phase 4：回讀稽核（非作者的檢查）───────────────────────────────
  audit.phase = 4;
  const expectText = new Map();
  for (const [u, b] of body) expectText.set(u, b.string);
  for (const [u, pieces] of splitPieces) {
    expectText.set(u, pieces[0]);
    const sp = splits.find((x) => x.uid === u);
    pieces.slice(1).forEach((p, k) => expectText.set(sp.newUids[k], p));
  }
  for (const mg of merges) {
    expectText.set(mg.uids[0], mg.uids.map((u) => body.get(u).string).join(mg.joiner ?? ""));
    for (const u of mg.uids.slice(1)) expectText.delete(u);
  }
  for (const bd of bolds) expectText.set(bd.uid, body.get(bd.uid).string.replace(bd.sentence, "**" + bd.sentence + "**"));
  for (const [u, b] of body) if (!normReformatText(b.string) && !(b.childUids || []).length) expectText.delete(u);

  let textBad = 0, refBad = 0, atomBad = 0;
  for (const [u, want] of expectText) {
    const cur = await api.pull(u);
    if (!cur) { fail(`稽核：block 不見了 ${u}`); textBad++; continue; }
    if (cur.string !== want) { fail(`稽核：字串不符 ${u}`); textBad++; }
  }
  for (const u of refd) if (!(await api.pull(u))) { fail(`稽核：被引用的 block 不見了 ${u}`); refBad++; }
  for (const u of atomIds) {
    const cur = await api.pull(u);
    if (!cur) { fail(`稽核：排除區 block 不見了 ${u}`); atomBad++; }
  }
  audit.check = { text: textBad === 0, refs: refBad === 0, atoms: atomBad === 0 };
  return finish();

  function finish() { audit.ok = audit.errors.length === 0; return audit; }
}


// roamAlphaAPI 適配層（測試時可換成本機 HTTP API 的同介面實作）
const roamPlanApi = {
  newUid: () => window.roamAlphaAPI.util.generateUID(),
  pull(uid) {
    const n = window.roamAlphaAPI.pull("[:block/uid :block/string :block/heading :block/order {:block/children [:block/uid :block/order]}]", [":block/uid", uid]);
    if (!n) return null;
    return { string: n[":block/string"] ?? "", heading: n[":block/heading"],
      childUids: ((n[":block/children"]) || []).slice().sort((a, b) => (a[":block/order"] || 0) - (b[":block/order"] || 0)).map((c) => c[":block/uid"]) };
  },
  create: ({ parent, order, uid, string, heading }) =>
    window.roamAlphaAPI.createBlock({ location: { "parent-uid": parent, order }, block: heading ? { uid, string, heading } : { uid, string } }),
  move: ({ parent, order, uid }) => window.roamAlphaAPI.moveBlock({ location: { "parent-uid": parent, order }, block: { uid } }),
  update: ({ uid, string, heading }) =>
    window.roamAlphaAPI.updateBlock({ block: heading == null ? { uid, string } : { uid, string, heading } }),
  del: (uid) => window.roamAlphaAPI.deleteBlock({ block: { uid } }),
};


// ── 改稿版次表（🗂）：套用成功後由 extension 自己補一行 ─────────────────────
// 2026-09-07 Bear 要求。原本 PROTOCOL §十 規定由 CC 手動維護，但同一天 CC 就漏了兩次
// （建提案時該記「待套用」、套用後該改「已套用」），兩次都要 Bear 提醒才補。
// 規則靠紀律就會漏；套用成功那一刻 extension 就在現場，知道搬了幾處、稽核過沒過、
// 而且時間是真的 → 這件事該是機器的副作用，不是人的待辦。
const VERSION_LOG_PREFIX = "🗂 改稿版次";
function findVersionLogs(pageUid) {
  try {
    return (window.roamAlphaAPI.q(
      `[:find ?u ?s :where [?b :block/page ?pg] [?pg :block/uid "${pageUid}"] [?b :block/uid ?u] [?b :block/string ?s]]`) || [])
      .filter(([, str]) => (str || "").trim().startsWith(VERSION_LOG_PREFIX))
      .map(([uid, str]) => ({ uid, str }));
  } catch (e) { console.warn("[請CC修改] findVersionLogs failed", e); return []; }
}
async function bumpVersionLog(pageUid, stats, audit, api) {
  const logs = findVersionLogs(pageUid);
  if (logs.length > 1) { console.warn("[請CC修改] 版次表不只一個，未自動更新", logs); return "⚠️ 版次表有多個，沒自動更新"; }
  const stamp = reformatStamp();
  const parts = [];
  if (stats.move)   parts.push(`搬移 ${stats.move}`);
  if (stats.promote) parts.push(`升格標題 ${stats.promote}`);
  if (stats.heads)  parts.push(`新建路標 ${stats.heads}`);
  if (stats.split)  parts.push(`切分 ${stats.split}→+${stats.splitNew}`);
  if (stats.merge)  parts.push(`合併 ${stats.merge}`);
  if (stats.bold)   parts.push(`加粗 ${stats.bold}`);
  if (stats.blanks) parts.push(`清空行 ${stats.blanks}`);
  const c = audit.check || {};
  const check = `稽核 內容${c.text ? "✅" : "❌"} 引用${c.refs ? "✅" : "❌"} 排除區${c.atoms ? "✅" : "❌"}`;
  const detail = `整篇重排版（${parts.join("／") || "無實質變更"}）；${check} → ✅ 已套用`;
  try {
    if (!logs.length) {                                  // 沒有就在頁面最上面建一個（🗂 開頭＝自動被排除）
      const root = api.newUid();
      await api.create({ parent: pageUid, order: 0, uid: root, string: `${VERSION_LOG_PREFIX}｜第 1 輪 · ${stamp}（整篇重排版）` });
      await api.create({ parent: root, order: 0, uid: api.newUid(), string: `第 1 輪｜${stamp}｜${detail}` });
      return "已新建版次表（在頁面最上面，記得搬到該稿底下）";
    }
    const log = logs[0];
    const m = /(v[0-9.]+)\s*·\s*第\s*(\d+)\s*輪/.exec(log.str);
    const ver = m ? m[1] : "v?";
    const n = m ? parseInt(m[2], 10) + 1 : 1;
    await api.update({ uid: log.uid, string: `${VERSION_LOG_PREFIX}｜${ver} · 第 ${n} 輪 · ${stamp}（整篇重排版）` });
    await api.create({ parent: log.uid, order: 0, uid: api.newUid(), string: `${ver} · 第 ${n} 輪｜${stamp}｜${detail}` });
    return `版次表 → ${ver} · 第 ${n} 輪`;
  } catch (e) { console.warn("[請CC修改] bumpVersionLog failed", e); return "⚠️ 版次表更新失敗（見 Console）"; }
}

// ── 日期／小工具 ──
function reformatStamp() { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; }
function reformatDate() { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
function escapeHtml(s) { return (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function tokenLabel(k) { return { link: "[[連結]]", blockref: "((引用))", highlight: "^^highlight^^", render: "{{元件}}", image: "圖片" }[k] || k; }

// ── 打包「整篇重排版」任務給新開的 Claude Code（閘門比轉Hugo 更嚴：未歸零就不複製）──
async function copyReformatPrompt() {
  const pg = currentPage(); if (!pg) return toast("找不到目前頁面");
  const todo = countMarkTag(TODO_TAG, pg.uid) + countMarkTag(PROP_TAG, pg.uid);
  const draft = countTagOnPage(DRAFT_TAG, pg.uid);
  if (todo || draft) return toast(`未歸零：還有 ${todo} 個標記／${draft} 個草稿，先清完才能打包重排`);   // 就地擋掉、不寫剪貼簿
  if (queryReformatProposal(pg.uid)) return toast("本頁已有排版提案，先套用或退回再重排");
  if (pageHasPublished(pg.uid)) return toast("本頁已發佈封存，排版請直接改 Hugo");
  const text =
`【整篇重排版 · 排版任務】
行為法典（第一步務必讀）：本機 /Users/tsaojian-hsiung/Desktop/Claude Code專用檔/roam-cc-mark/PROTOCOL.md（§九 整篇重排版；備援 raw：https://raw.githubusercontent.com/agoodbear/roam-cc-mark/main/PROTOCOL.md）
對象：Roam page「${pg.title}」（page uid: ${pg.uid}）
本頁狀態：標記 0／草稿 0（已歸零，可重排）
${(() => { const r = [...inboundRefs(pg.uid, null)]; const b = gatherBodyStruct(pg.uid).body;
  const lines = r.filter((u) => b.has(u)).map((u) => `   ((${u}))　${(b.get(u).string || "").replace(/\n/g, " ").slice(0, 24)}`);
  return lines.length ? `\n⚠️ 石頭清單（這 ${lines.length} 段被其他 block 引用，只准整段搬，不准切/併/加粗/刪）：\n${lines.join("\n")}\n` : "\n（本頁沒有被外部引用的段落）\n"; })()}

情境（決定你該往哪裡看）：
這篇內容已經完整，但它是**經過多輪「請CC修改」之後的稿**——「接」的草稿是插在「當時標記
掛在哪」而不是「內容該在哪」，「潤」只動被圈的那句、不管前後銜接。所以典型病灶是：段落
顆粒忽長忽短、同一個主題散在相隔很遠的兩三處、某段讀起來像後來塞進去的、全篇平鋪沒骨架。

⚠️ 最重要的一件事——**排版順序不是你的判斷，是 Bear 的骨架。**
他 37 篇 ECG 文走同一條敘事骨架（Fable 5 逐篇提煉、原文佐證見
/Users/tsaojian-hsiung/Desktop/Claude Code專用檔/ecg-writing-style-profile.md 的 §1，
**動手前先讀那一節**）：

  ① 邀請開場（一句，「今天這個 case 很有趣」）
  ② 病人一句話速寫（年齡＋性別＋主訴＋現場畫面，極短）
  ③ 丟第一張 ECG ＋ 五宮格判讀（Rate-Rhythm-Axis-Interval-Ischemia）
  ④ 先問自己幾個問題 Q1/Q2/Q3…（全文路線圖，隱形鋼骨）
  ⑤ 教學離題（DDx／機轉／文獻）  ┐
  ⑥ 拉回個案（明確路標）          ┘ ⑤⑥ **反覆交替 n 輪**，像剝洋蔥（post-16 有四次）
  ⑦ 反轉／serial ECG 揭示
  ⑧ 診斷揭曉（CAG 報告）
  ⑨ 感悟／後怕／急診人生
  ⑩ 學習重點（編號清單）
  ⑪ 參考資料

你的工作是**把每一段歸到它該在的格子**，再照 ①②③④→(⑤⑥)×n→⑦⑧⑨⑩⑪ 落位。
歸格要交代理由（見【結構診斷】的【骨架對位】），Bear 要能一條一條檢查你有沒有亂歸。
不是每篇都用滿 11 格；缺的格子寫「本篇無」，**不要自己生內容去填**。

⚠️ 鐵律（凌駕一切，違反任一條＝任務失敗）：
1. 這是「排版」不是「改稿」。**v10 起你根本不會碰到 Bear 的字**——提案樹裡只放
   ((uid)) 與新標題，套用時 extension 搬的是 Bear 自己的 block。所以「不改字」不是
   你要小心的事，是結構上做不到的事。你要小心的是「有沒有漏段、有沒有動到不該動的」。
2. 你只能做六件事：
   ① 加標題：**你不准自己造標題。** 只有兩種來源，各自寫成獨立 block：
      (a) **升格**（優先用這個）：「## ((uid))」或「### ((uid))」——把 Bear **自己寫的那一句**
          升格成標題。字不變、uid 不變、引用不斷，長度與數字都不受限制。
          他的標題天生就是在說話：「**Step 1:排除artifact**」「如果這時候的AIVR是115下，
          你還是認得出AIVR嗎?」「這.....是不是VT」「要診斷出inverted U wave，首先有一個難關。」
          —— 從內文找那一句，升格它。這是「有靈魂」跟「像目錄」的分水嶺。
      (b) **路標白名單**：只有這些字准新建，其他一律退件——
          Case繼續／Case個案繼續／❤️Case個案繼續／↩️Back to case／Back to Case／拉回正題～～／
          回到此個案～～／回到病人／先問自己幾個問題／學習重點:／文章重點:／參考資料:／
          參考文獻／事後回顧感想／延伸閱讀／Learning Points:／統整／小結
          （前後可加 ❤️ ↩️ ** <mark> ~~ 冒號等裝飾，會照你寫的樣子建出來。）
      ⑤⑥ 每交替一輪，就用一個 (b) 的拉回路標把讀者接回病人身上——那是他的節拍器
      （18 篇裡出現 27 次）。
      **判準：Bear 把全篇折疊起來只剩這些標題時，要能照著重講一次這篇在說什麼。**
   ② 層級化（本版重點，直接決定觀看體驗）：
      (a) **章節縮排**——每一節的正文段落縮排成該節「## 」標題的**子層**，「### 」小節縮在
          所屬「## 」之下、該小節正文再縮一層。這樣 Bear 在 Roam 折疊 bullet 就能把全篇
          收成一份骨架。第一個標題之前的開場段落留在頂層、不縮排。
      (b) 連續平行短句縮排為子層（Roam bullet 即清單）。
   ③ 切分過長段落：寫進【切分】宣告行；切點要落在句末標點或換行處。**含換行的巨型
      block 現在切得動了**（換行不是字，extension 會丟掉）。
   ④ 合併零碎段落：寫進【合併】宣告行，不得補字補標點（需要補才通順→寫進【結構診斷】）。
   ⑤ 整句加粗：寫進【加粗】宣告行，只對「可直接抄進筆記的臨床結論／判斷整句」，全篇 ≤5 處。
   ⑥ 清雜訊：刪純空白 block。
3. 不碰：**任意深度**開頭為 🗂／🗄 的 block（素材、備份、改稿版次表）、「✅ 已發佈」行、所有 #標記 block。
   這些不進正文、提案樹不准引用它們；它們會自己跟著父層走。
   照片 block（![📷 …](composer.agoodbear.com/…)）逐字保留、跟著原本相鄰段落放。
4. **v10 起你可以搬段落、跨節重排、合併**——這正是這一版做出來的目的。每一處由 extension
   從樹算出來並列在卡片上，不靠你自報。但**被其他 block 引用的段落是石頭**（清單見下），
   只准整段搬，不准切、不准併掉、不准加粗、不准刪。
5. 原稿一個 block 都不准動（不 update、不 delete、不 move）。你的全部產出只放進下述提案樹。
6. 【重排結果】底下每個節點的字串**只准是三種之一**，多一個字都會被退件：
   ・「((uid))」——正文的某個 block，維持原樣
   ・「## ((uid))」／「### ((uid))」——**升格**：同一個 block，只是變成標題（字與 uid 不動）
   ・「## 路標」／「### 路標」——新建，且**必須命中白名單**（見鐵律 2①(b)），全篇 ≤15 個
   自由造句的標題會被 V2_HEAD_FREE 直接退件——長度與數字限制已經拿掉，因為造句那條路封死了。
   **葉節點（提案裡沒有子節點）＝這段連同它現有的整棵子樹原樣照搬**；有子節點＝它的子層由你明列。
   所以只有動到結構的地方要展開，沒動的整棵寫一行就好。順序就是樹本身，不要寫 order／index。

步驟：
1. 讀上面 PROTOCOL.md §九。
2. 用 Roam MCP 讀整頁 ${pg.uid}（含所有 block 與層級；素材子樹讀了理解脈絡但不入結果）。
3. 在頁面「最底部」建一個 top-level block：「#cc排版提案 【整篇重排版】${reformatDate()}」，其下三個子 block：
   - 「【變更摘要】升格標題 N｜新建路標 N｜縮排 N 節｜切分 N｜合併 N｜加粗 N｜清空行 N」，
     其子層逐條列明細（每個升格句的 uid＋全文、每個路標全文、每處合併/切分/加粗的位置與原文前 10 字）。
   - 「【結構診斷】離群 N｜接縫 N｜頭尾 <撐得住／要補>」——**這一節不准寫「無」交差**，
     要逐段掃過才准下結論。五個必填子層：
       (a)【骨架對位】**這一格是這一版的重點**。骨架 ①–⑪ 逐格一行：
           「② 病人一句話速寫｜((uid)) 或「本篇無」｜為什麼歸這格：<一句>」。
           歸不進任何一格的段落，列在最後「⑫ 歸不進去的」，一段一行寫理由。
       (b)【節次地圖】每節一行：「## 標題｜第X–Y段｜這節在講：<一句話>」。
       (c)【離群段】跟所在節主題不合、或跟同主題段落被隔很遠的段落。一段一行：
           「第X段〔原文前12字〕｜現在在<節>｜建議移到<節>之後｜理由：<一句>」。
           逐段檢查後真的沒有 → 寫「逐段檢查 N 段，無離群」（N 要寫出實數）。
       (d)【接縫】讀起來銜接生硬、像後來塞進去的段落（多輪改稿最常見的病灶）。一處一行：
           斷在哪兩段之間、缺的是什麼（轉折？前提？跟前面重複了？）。只診斷，不准補字。
       (e)【頭尾】開頭第一段、結尾最後一段各評一句：還撐不撐得住？撐不住是缺什麼？
           對照骨架①邀請開場與⑨感悟——這兩格他幾乎每篇都有，缺了要講。
   - 「【切分】」（沒有就不建）每行一條：
       ((uid))｜切點：「…切點前12字」‖「切點後12字…」→ ((新uid))
       ((uid))｜依換行 → ((新uid1)) ((新uid2)) …
   - 「【合併】」（沒有就不建）每行一條：((存活uid)) ＋ ((被併掉uid)) …｜接合：無／換行／空格
   - 「【加粗】」（沒有就不建）每行一條：((uid)) 「整句」　全篇 ≤5
   - 「【重排結果】」：其直接子層＝重排後的完整正文樹，**每個節點只能是 ((uid)) 或 ##／### 標題**
     （見鐵律 6）。章節縮排：正文縮成該節標題的子層。順序＝骨架順序，不是原稿順序。
4. 回 chat 一份對帳清單：**【骨架對位】整張表**＋各章標題＋每類變更數；離群段與接縫逐條列在 chat
   （Bear 要直接讀，不想再翻回 Roam）。
（更多脈絡：查 Supabase handovers 最近幾筆這篇的紀錄。）`;
  try { await navigator.clipboard.writeText(text); toast("已複製「整篇重排版」任務 ✅ 貼到新的 CC session"); }
  catch (e) { console.warn(e); toast("複製失敗（剪貼簿權限）"); }
}

// ── 套用重排（先促升提案樹、再刪舊正文；套用前再驗一次歸零＋零位移）──────────────────
// 2026-09-03 Bear 決定不留備份：零位移已逐字驗證，同頁存第二份原稿是多此一舉。
// ↺ 還原／🧹 清備份保留給更早留下的舊備份用。
async function applyReformat() {
  const pg = currentPage(); if (!pg) return toast("找不到目前頁面");
  const marks = countMarkTag(TODO_TAG, pg.uid) + countMarkTag(PROP_TAG, pg.uid);   // 閘門①：歸零
  const draft = countTagOnPage(DRAFT_TAG, pg.uid);
  if (marks || draft) return toast(`還有 ${marks} 標記／${draft} 草稿未清，不能套用`);
  const prop = queryReformatProposal(pg.uid);                                      // 閘門②：提案存在
  if (!prop || !prop.resultUid) return toast("找不到重排提案（或缺【重排結果】）");
  if (prop.isV9) return toast("這是 v9 副本式提案（【重排結果】放的是正文副本）。v10 起只收 ((uid)) 計畫，請退回、用新 prompt 重跑");
  if (!prop.planTree.length) return toast("【重排結果】是空的，未套用");

  const { body, atomIds, excludedRoots } = gatherBodyStruct(pg.uid);               // 閘門③：重跑計畫驗證
  const refd = inboundRefs(pg.uid, prop.rootUid);
  const ctx = { body, atomIds, refd, tree: prop.planTree, splits: prop.splits, merges: prop.merges,
                bolds: prop.bolds, pageUid: pg.uid, excludedRoots, proposalRootUid: prop.rootUid };
  const vr = verifyReformatPlan(ctx);
  if (!vr.ok) { console.warn("[請CC修改] plan 驗證未過", vr.errors); return toast(`計畫驗證未過（${vr.errors.length} 條），已鎖住套用`); }

  try { localStorage.setItem("ccm-reformat-snapshot-" + pg.uid,                     // Phase 0：本機快照（不動 Roam 頁面，但留一條回頭路）
    JSON.stringify(window.roamAlphaAPI.pull("[:block/uid :block/string :block/order :block/heading {:block/children ...}]", [":block/uid", pg.uid]))); } catch (e) {}
  if (body.size > 60) toast("套用中…大頁面請稍候");
  applying = true;
  let audit = null;
  try {
    audit = await applyReformatPlan(ctx, roamPlanApi, (m) => console.log("[請CC修改][v10] " + m));
    let verMsg = "";
    if (audit.ok) verMsg = await bumpVersionLog(pg.uid, vr.stats, audit, roamPlanApi);   // 版次表：機器自己記，不靠 CC
    if (audit.ok) toast(`已套用重排版（搬 ${audit.moved}／新建 ${audit.created}／改字 ${audit.updated}／刪 ${audit.deleted}；稽核：內容${audit.check.text ? "✅" : "❌"} 引用${audit.check.refs ? "✅" : "❌"} 排除區${audit.check.atoms ? "✅" : "❌"}）　${verMsg}`);
    else toast(`套用未完成（${audit.errors.length} 條問題，見 Console）。正文完整、沒有刪除，可再按一次接著跑`);
  } catch (e) {
    console.warn("[請CC修改] applyReformatPlan failed", e, audit);
    toast("套用中斷（見 Console）：最後一步之前沒有任何刪除，正文完整——再按一次套用會接著做完");
  }
  setTimeout(() => { applying = false; closeReformatCard(); refreshDecorations(true); }, 60);
}

// ── 還原：不刪任何東西——當前正文移進新「🗄 還原前狀態」root，再把備份子樹促升回來 ──
async function restoreReformatBackup() {
  const pg = currentPage(); if (!pg) return toast("找不到目前頁面");
  const backups = queryReformatBackups(pg.uid);
  const backup = backups.find((b) => /排版前備份/.test(b.str)) || backups[0];
  if (!backup) return toast("找不到排版前備份");
  let btree;
  try { btree = window.roamAlphaAPI.pull("[:block/uid {:block/children [:block/uid :block/order]}]", [":block/uid", backup.uid]); }
  catch (e) { return toast("讀備份失敗"); }
  const backupKids = ((btree && btree[":block/children"]) || []).slice().sort((a, b) => (a[":block/order"] || 0) - (b[":block/order"] || 0));
  if (!backupKids.length) return toast("備份是空的，無法還原");
  const curBody = topLevelBodyUids(pg.uid);   // 套用後可能已改字的當前正文 → 也保住，不默默吃掉
  applying = true;
  try {
    const holdUid = window.roamAlphaAPI.util.generateUID();
    await window.roamAlphaAPI.createBlock({ location: { "parent-uid": pg.uid, order: "last" }, block: { string: `🗄 還原前狀態 ${reformatStamp()} #${REFORMAT_BACKUP_TAG}`, uid: holdUid } });
    try { await window.roamAlphaAPI.updateBlock({ block: { uid: holdUid, open: false } }); } catch (e) {}   /* 待 live 驗：open */
    let ho = 0;
    for (const b of curBody) await window.roamAlphaAPI.moveBlock({ location: { "parent-uid": holdUid, order: ho++ }, block: { uid: b.uid } });   /* 待 live 驗：moveBlock */
    let po = 0;
    for (const k of backupKids) await window.roamAlphaAPI.moveBlock({ location: { "parent-uid": pg.uid, order: po++ }, block: { uid: k[":block/uid"] } });   /* 待 live 驗：moveBlock */
    await window.roamAlphaAPI.deleteBlock({ block: { uid: backup.uid } });   // 刪空的舊備份 root（原稿已促升回頁面）
    toast("已還原排版前原稿（套用後狀態存到新備份 🗄）");
  } catch (e) {
    console.warn("[請CC修改] restoreReformatBackup failed", e);
    toast("還原失敗（見 Console）");
  }
  setTimeout(() => { applying = false; closeReformatCard(); refreshDecorations(true); }, 60);
}
// 🧹 清除備份（走 confirm；刪本頁所有 #cc排版備份 root）
async function clearReformatBackup() {
  const pg = currentPage(); if (!pg) return toast("找不到目前頁面");
  const backups = queryReformatBackups(pg.uid);
  if (!backups.length) return toast("找不到排版備份");
  if (!window.confirm("確定清除排版前備份？此動作永久刪除備份子樹，原稿將無法一鍵還原。")) return;
  applying = true;
  try { for (const b of backups) await window.roamAlphaAPI.deleteBlock({ block: { uid: b.uid } }); toast("已清除排版備份"); }
  catch (e) { console.warn("[請CC修改] clearReformatBackup failed", e); toast("清除失敗（見 Console）"); }
  setTimeout(() => { applying = false; closeReformatCard(); refreshDecorations(true); }, 60);
}
// ↩ 退回：刪整份提案（原稿本來就沒動過，不受影響）
async function returnReformatProposal(prop) {
  if (!prop || !prop.rootUid) return;
  if (!window.confirm("退回並刪除整份重排提案？（原稿未動、不受影響；CC 需重跑才會再有提案）")) return;
  try { await window.roamAlphaAPI.deleteBlock({ block: { uid: prop.rootUid } }); toast("已退回（刪除重排提案，原稿未動）"); }
  catch (e) { console.warn("[請CC修改] returnReformat failed", e); toast("退回失敗（見 Console）"); }
  setTimeout(() => { closeReformatCard(); refreshDecorations(true); }, 60);
}

// ── 👀 對照：右側欄開提案樹，主欄看原稿並排；rightSidebar 不可用就降級成捲到提案 ──
function openReformatCompare(prop) {
  try {
    const rs = window.roamAlphaAPI.ui && window.roamAlphaAPI.ui.rightSidebar;
    if (rs && rs.addWindow) {
      rs.addWindow({ window: { type: "block", "block-uid": prop.resultUid || prop.rootUid } });   /* 待 live 驗：rightSidebar.addWindow */
      try { rs.open(); } catch (e) {}
      return toast("提案已開在右側欄，主欄可對照原稿");
    }
  } catch (e) { console.warn("[請CC修改] rightSidebar addWindow failed", e); }
  const el = findBlockTextEl(prop.rootUid);   // 降級：捲到提案 root（不 throw、不卡住）
  if (el) { el.scrollIntoView({ block: "center" }); toast("已捲到提案（右側欄不可用，降級為主欄捲動）"); }
  else toast("找不到提案位置");
}

// ── 三態卡（B 待審 > C 已套用 > A 待打包）：fixed 錨在 FAB 上方，視覺同 .ccm-bubble 家族 ──
function closeReformatCard() { if (reformatCard) { reformatCard.remove(); reformatCard = null; } }
function reformatState(pg) {
  const prop = queryReformatProposal(pg.uid);
  if (prop) return { kind: "B", prop };
  const backups = queryReformatBackups(pg.uid);
  if (backups.length) return { kind: "C", backups };
  return { kind: "A" };
}
function openReformatCard() {
  if (reformatCard) { closeReformatCard(); return; }   // 再點一下＝關
  const pg = currentPage(); if (!pg) return toast("找不到目前頁面");
  reformatCard = buildReformatCard(pg);
  document.body.appendChild(reformatCard);
}
function buildReformatCard(pg) {
  const card = document.createElement("div");
  card.className = "ccm-reformat-card";
  const st = reformatState(pg);
  const closeX = `<span class="ccm-rc-x" title="關閉">✕</span>`;
  if (st.kind === "B") {   // 提案待審：摘要＋零位移驗證＋👀對照＋✅套用（驗不過鎖住）＋↩退回
    const prop = st.prop;
    const { body, atomIds, excludedRoots } = gatherBodyStruct(pg.uid);
    const refd = inboundRefs(pg.uid, prop.rootUid);
    const ctx = { body, atomIds, refd, tree: prop.planTree, splits: prop.splits, merges: prop.merges,
                  bolds: prop.bolds, pageUid: pg.uid, excludedRoots, proposalRootUid: prop.rootUid };
    const vr = prop.isV9 ? { ok: false, errors: [{ code: "V0_LEGACY", msg: "v9 副本式提案：【重排結果】放的是正文副本。v10 起只收 ((uid)) 計畫，請退回、用新 prompt 重跑" }], stats: null } : verifyReformatPlan(ctx);
    const suggest = (prop.suggestStr || "").replace(/^[\s\S]*?【(?:結構診斷|建議)】/, "").trim();

    let verifyHtml;
    if (vr.ok) {
      const t = vr.stats;
      verifyHtml = `<div class="ccm-rc-verify ok">計畫驗證：✅ 通過（13 項檢查）<br>` +
        `<span class="ccm-rc-hint">搬移 ${t.move}（其中整棵照搬 ${t.leafWhole}）｜升格標題 ${t.promote}｜新建路標 ${t.heads}｜切分 ${t.split}→+${t.splitNew}｜合併 ${t.merge}｜加粗 ${t.bold}｜刪空白 ${t.blanks}｜被引用不可動 ${t.refd}　—— 這些數字由 extension 算出，不是 CC 自報</span></div>`;
    } else {
      verifyHtml = `<div class="ccm-rc-verify bad">計畫驗證：❌ ${vr.errors.length} 條問題<br>` +
        vr.errors.slice(0, 6).map((e) => `・${escapeHtml(e.msg)}`).join("<br>") +
        (vr.errors.length > 6 ? `<br><span class="ccm-rc-hint">其餘 ${vr.errors.length - 6} 條見 Console</span>` : "") + `</div>`;
      console.warn("[請CC修改] plan 驗證未過", vr.errors);
    }
    // v11：新建的標題只能是路標白名單（機器擋死），升格的標題是 Bear 自己的句子。
    // 兩種都列出來，因為「哪一句被拉去當標題」本身就是排版決定，要他看得到。
    const ht = (vr.stats && vr.stats.headTexts) || [];
    const pt = (vr.stats && vr.stats.promoTexts) || [];
    const headsHtml =
      (pt.length
        ? `<div class="ccm-rc-suggest">🏷 升格成標題 ${pt.length} 句（都是你自己寫的字，一字未改）：<br>` +
          pt.map((t) => `・${escapeHtml(t.length > 46 ? t.slice(0, 46) + "…" : t)}`).join("<br>") + `</div>`
        : "") +
      (ht.length
        ? `<div class="ccm-rc-suggest">🚩 新建路標 ${ht.length} 個（唯一原稿沒有的字，只能出自白名單）：<br>` +
          ht.map((t) => `・${escapeHtml(t)}`).join("<br>") +
          `<br><span class="ccm-rc-hint">其餘內容一個字都沒被複製過——CC 只給了 ((uid))，套用時搬的是你自己的 block</span></div>`
        : "");

    card.innerHTML =
      `<div class="ccm-rc-head">📐 Roam 排版提案 · 待審 ${closeX}</div>` +
      verifyHtml + headsHtml +
      (suggest && suggest !== "無" ? `<div class="ccm-rc-suggest">🧭 結構診斷：${escapeHtml(suggest)}<br><span class="ccm-rc-hint">明細（節次地圖／離群段／接縫／頭尾）在 Roam 提案樹下，套用前先看</span></div>` : "") +
      `<div class="ccm-rc-actions"><button class="ccm-rc-compare">👀 對照</button><button class="ccm-rc-apply">✅ 套用（搬不刪）</button><button class="ccm-rc-return">↩ 退回</button></div>`;
    card.querySelector(".ccm-rc-compare").onclick = () => openReformatCompare(prop);
    const applyBtn = card.querySelector(".ccm-rc-apply");
    if (!vr.ok) { applyBtn.disabled = true; applyBtn.classList.add("ccm-rc-disabled"); applyBtn.title = "計畫驗證未過，已鎖住（fail-closed）"; }
    applyBtn.onclick = () => { if (vr.ok) applyReformat(); };
    card.querySelector(".ccm-rc-return").onclick = () => returnReformatProposal(prop);
  } else if (st.kind === "C") {   // 已套用：↺ 還原／🧹 清除備份
    card.innerHTML =
      `<div class="ccm-rc-head">📐 Roam 已套用重排版 ${closeX}</div>` +
      `<div class="ccm-rc-status">頁底有舊版留下的 🗄 備份（2026-09-03 起套用已不再建備份）</div>` +
      `<div class="ccm-rc-actions"><button class="ccm-rc-restore">↺ 還原排版前備份</button><button class="ccm-rc-clear">🧹 清除備份</button></div>`;
    card.querySelector(".ccm-rc-restore").onclick = () => restoreReformatBackup();
    card.querySelector(".ccm-rc-clear").onclick = () => clearReformatBackup();
  } else {   // A｜尚無提案：狀態＋歸零閘門＋打包鈕
    const todo = countMarkTag(TODO_TAG, pg.uid), prop = countMarkTag(PROP_TAG, pg.uid), draft = countTagOnPage(DRAFT_TAG, pg.uid);
    const published = pageHasPublished(pg.uid);
    const zeroed = todo + prop === 0 && draft === 0;
    let banner;
    if (published) banner = `<div class="ccm-rc-warn">⚠️ 本頁已發佈封存，排版請直接改 Hugo</div>`;
    else if (!zeroed) banner = `<div class="ccm-rc-warn">⚠️ 還有 ${todo + prop} 個標記／${draft} 個草稿，先清完才能重排</div>`;
    else banner = `<div class="ccm-rc-ok">✅ 可重排</div>`;
    card.innerHTML =
      `<div class="ccm-rc-head">📐 Roam 整篇重排版 ${closeX}</div>` +
      `<div class="ccm-rc-status">本頁狀態：待處理 ${todo} · 待審 ${prop} · 草稿 ${draft}</div>` +
      banner +
      `<div class="ccm-rc-actions"><button class="ccm-rc-pack">📋 打包重排版任務給 CC</button></div>`;
    const packBtn = card.querySelector(".ccm-rc-pack");
    if (published || !zeroed) { packBtn.disabled = true; packBtn.classList.add("ccm-rc-disabled"); }
    packBtn.onclick = () => copyReformatPrompt();
  }
  const x = card.querySelector(".ccm-rc-x"); if (x) x.onclick = () => closeReformatCard();
  return card;
}
// 每輪輕量切換 FAB 文案（不重驗零位移，只查提案是否存在）
function updateReformatBtn(pageUid) {
  if (!reformatBtn) return;
  const has = pageUid ? countTagOnPage(REFORMAT_PROP_TAG, pageUid) > 0 : false;
  reformatBtn.textContent = has ? "📐 Roam排版提案 ●" : "📐 Roam重排版";
  reformatBtn.classList.toggle("on", has);
}

// ── 從 Blog Composer 挑照片插入 ───────────────────────────────
function openPhotoPicker(uid) {
  photoLastUid = uid;   // 第一張插在這個 block 後面，之後每張鏈在前一張後面
  const url = BC_URL + "/?picker=1&origin=" + encodeURIComponent(window.location.origin);
  try {
    photoPopup = window.open(url, "ccm-bc-picker", "width=1100,height=820");
    if (!photoPopup) return toast("彈窗被擋住了，請允許此站開啟彈出視窗");
    toast("在彈出的 Blog Composer 挑照片，點縮圖即插入（可連續挑）");
  } catch (e) { console.warn("[請CC修改] open picker failed", e); toast("開啟 Blog Composer 失敗"); }
}
async function insertPhotoBlock(d) {
  if (!photoLastUid || !d || !d.thumbUrl) return;
  const cap = String(d.caption || d.name || "照片").replace(/[\[\]]/g, "");
  const md = "![📷 " + cap + "](" + d.thumbUrl + ")";
  try {
    const pos = siblingAfter(photoLastUid);
    const uid = window.roamAlphaAPI.util.generateUID();
    await window.roamAlphaAPI.createBlock({ location: { "parent-uid": pos.parent, order: pos.order }, block: { string: md, uid } });
    photoLastUid = uid;   // 下一張接在這張後面，維持挑選順序
    toast("已插入照片：" + cap);
    setTimeout(() => refreshDecorations(true), 150);
  } catch (err) { console.warn("[請CC修改] insert photo failed", err); toast("插入照片失敗（見 Console）"); }
}

function toast(msg) {
  const t = document.createElement("div");
  t.className = "ccm-toast"; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; }, 1800);
  setTimeout(() => { t.remove(); }, 2300);
}

// ── build UI ─────────────────────────────────────────────────
function buildUI() {
  overlayEl = document.createElement("div"); overlayEl.className = "ccm-overlay"; document.body.appendChild(overlayEl);

  triggerBtn = document.createElement("div");
  triggerBtn.className = "ccm-trigger"; triggerBtn.style.display = "none";
  triggerBtn.addEventListener("mousedown", (e) => e.preventDefault());   // 保住選取，不讓點按收掉 selection
  // 左：＋新段（以整個 block 為單位、接一段在它後面）；右：請CC修改（改選取的字）
  const trigInsert = document.createElement("div");
  trigInsert.className = "ccm-trig-btn ccm-trig-insert"; trigInsert.textContent = "＋ 新段";
  trigInsert.title = "在這個 block 後面插入新段（接，以整段為單位）";
  trigInsert.addEventListener("click", () => {
    if (!pending || !pending.marks || !pending.marks[0]) return hideTrigger();
    const uid = pending.marks[0].parentUid;
    const r = triggerBtn.getBoundingClientRect(); hideTrigger();
    pending = { mode: "create", marks: [{ parentUid: uid, quote: "", occurrence: 1 }], label: "（在此 block 後面插入新段）" };
    panelIntent = "接";
    showPanel(r.left + window.scrollX + r.width / 2, r.top + window.scrollY, pending.label, "");
  });
  // 中：📷 加照片（開 Blog Composer picker 彈窗，挑的照片插在這個 block 後面）
  const trigPhoto = document.createElement("div");
  trigPhoto.className = "ccm-trig-btn ccm-trig-photo"; trigPhoto.textContent = "📷 加照片";
  trigPhoto.title = "從 Blog Composer 挑照片，插在這個 block 後面";
  trigPhoto.addEventListener("click", () => {
    if (!pending || !pending.marks || !pending.marks[0]) return hideTrigger();
    const uid = pending.marks[0].parentUid; hideTrigger();
    openPhotoPicker(uid);
  });
  const trigMark = document.createElement("div");
  trigMark.className = "ccm-trig-btn"; trigMark.textContent = "✏️ 請CC修改";
  trigMark.addEventListener("click", () => {
    if (!pending) return hideTrigger();
    const r = triggerBtn.getBoundingClientRect(); hideTrigger();
    showPanel(r.left + window.scrollX + r.width / 2, r.top + window.scrollY, pending.label || "", "");
  });
  triggerBtn.appendChild(trigInsert); triggerBtn.appendChild(trigPhoto); triggerBtn.appendChild(trigMark);
  document.body.appendChild(triggerBtn);

  panelEl = document.createElement("div"); panelEl.className = "ccm-panel";
  panelEl.innerHTML =
    '<div class="ccm-head">✏️ 請CC修改</div>' +
    '<div class="ccm-intents">' + INTENTS.map((it, i) => `<button data-intent="${it}" title="⌥${i + 1}">${it}</button>`).join("") + '</div>' +
    '<div class="ccm-hint"></div>' +
    '<div class="ccm-picked"></div>' +
    '<div class="ccm-ref"></div>' +
    '<textarea placeholder="一句話說怎麼改…（Enter 送出，⌥1–4 選意圖）"></textarea>' +
    '<div class="ccm-chips"><span>口語化</span><span>縮短</span><span>去 AI 腔</span></div>' +
    '<div class="ccm-actions"><button class="ccm-delete">刪除</button><button class="ccm-cancel">取消</button><button class="ccm-save">送出</button></div>';
  document.body.appendChild(panelEl); panelEl.style.display = "none";

  panelEl.querySelectorAll(".ccm-intents button").forEach((btn) => btn.onclick = () => { setIntent(btn.dataset.intent); panelEl.querySelector("textarea").focus(); });
  panelEl.querySelector(".ccm-chips").addEventListener("click", (e) => {
    if (e.target.tagName === "SPAN") { const ta = panelEl.querySelector("textarea"); ta.value = (ta.value ? ta.value + "、" : "") + e.target.textContent; ta.focus(); }
  });
  panelEl.querySelector(".ccm-cancel").onclick = hidePanel;
  panelEl.querySelector(".ccm-save").onclick = submitPanel;
  panelEl.querySelector(".ccm-delete").onclick = () => { if (pending && pending.mode === "edit") { const uid = pending.childUid; hidePanel(); deleteMark(uid); } else hidePanel(); };
  panelEl.querySelector("textarea").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitPanel(); return; }
    if (e.key === "Escape") { hidePanel(); return; }
    if (e.altKey && /^Digit[1-4]$/.test(e.code)) { e.preventDefault(); setIntent(INTENTS[parseInt(e.code.slice(5), 10) - 1]); }
  });

  pillEl = document.createElement("div"); pillEl.className = "ccm-pill"; pillEl.style.display = "none";
  pillEl.onclick = () => toggleNav(); document.body.appendChild(pillEl);

  navEl = document.createElement("div"); navEl.className = "ccm-nav"; navEl.style.display = "none";
  navEl.innerHTML =
    '<button class="ccm-nav-prev" title="上一個 (⌥↑)">▲</button>' +
    '<span class="ccm-nav-label">–</span>' +
    '<button class="ccm-nav-next" title="下一個 (⌥↓)">▼</button>' +
    '<button class="ccm-nav-acc" title="接受這個 (⌥Enter)" style="display:none">✅</button>' +
    '<button class="ccm-nav-rej" title="退回改寫 (⌥R)" style="display:none">↩</button>' +
    '<button class="ccm-nav-copy" title="打包本頁待處理標記給 CC">📋</button>';
  navEl.querySelector(".ccm-nav-prev").onclick = () => navGo(-1);
  navEl.querySelector(".ccm-nav-next").onclick = () => navGo(1);
  navEl.querySelector(".ccm-nav-acc").onclick = () => navAccept();
  navEl.querySelector(".ccm-nav-rej").onclick = () => navReject();
  navEl.querySelector(".ccm-nav-copy").onclick = () => copyMarksPrompt();
  document.body.appendChild(navEl);

  buildCurtain();
  fabRow = document.createElement("div"); fabRow.className = "ccm-fabrow";
  reformatBtn = document.createElement("div"); reformatBtn.className = "ccm-fab-btn ccm-reformat-btn"; reformatBtn.textContent = "📐 Roam重排版";
  reformatBtn.title = "整篇重排版：打包給 CC 依內容重排（只動版面、不改一個字），提案回來後在這裡預覽＋一鍵套用。轉Hugo 前的最後整理。";
  reformatBtn.onclick = () => openReformatCard();
  hugoBtn = document.createElement("div"); hugoBtn.className = "ccm-fab-btn ccm-hugo-btn"; hugoBtn.textContent = "🚀 轉Hugo";
  hugoBtn.title = "本頁改完了 → 打包「轉 Hugo 成稿」任務，貼給新開的 Claude Code session";
  hugoBtn.onclick = () => copyHugoPrompt();
  curtainBtn = document.createElement("div"); curtainBtn.className = "ccm-fab-btn ccm-curtain-btn"; curtainBtn.textContent = "🪟 審稿簾";
  curtainBtn.title = "審稿簾：往下審過就把右側握把拉下，簾子蓋住已審區追蹤進度";
  curtainBtn.onclick = () => setCurtain(!curtainOn);
  toggleBtn = document.createElement("div"); toggleBtn.className = "ccm-toggle ccm-fab-btn";
  toggleBtn.title = "開 / 關標記模式（⌥M 隨時可標）"; toggleBtn.onclick = () => setActive(!active);
  // DOM 順序：📐 重排版 → 🚀 轉Hugo → 🪟 審稿簾 → ✏️ 標記模式（工作流：先排版、後轉檔；開關類靠右）
  fabRow.appendChild(reformatBtn); fabRow.appendChild(hugoBtn); fabRow.appendChild(curtainBtn); fabRow.appendChild(toggleBtn);
  document.body.appendChild(fabRow); updateToggle();
}

function updatePill(todo, review, draft) {
  if (!pillEl) return;
  if (!todo && !review && !draft) { pillEl.style.display = "none"; if (navEl) navEl.style.display = "none"; return; }
  pillEl.style.display = "block";
  pillEl.innerHTML = `📝 待處理 <b>${todo}</b>` + (review ? ` · <span class="ccm-rev">待審 ${review}</span>` : "") + (draft ? ` · <span class="ccm-draft">草稿 ${draft}</span>` : "");
}

// ── 上下導覽 ─────────────────────────────────────────────────
function navMarks() {
  const els = Array.from(document.querySelectorAll(".ccm-underline, .ccm-underline-review, .ccm-underline-draft, .ccm-block-flag, .ccm-block-flag-review, .ccm-block-flag-draft"));
  els.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  return els;
}
function hideNavBubble() { if (navBubble) { navBubble.remove(); navBubble = null; } }
function showNavBubble(anchorEl, m) {
  hideNavBubble(); removeHoverBubble();   // singleton：導覽泡泡出現時也收掉 hover 泡泡
  const b = buildBubbleDOM(m, anchorEl);
  b.__ccmNav = m.childUid;
  document.body.appendChild(b); positionBubble(b, anchorEl);   // 放 body，不隨 overlay 重畫被清掉
  navBubble = b;
}
// 重畫後：導覽泡泡的標記若還在就重新對位，不在就收掉（遠處捲動觸發虛擬化重繪的兜底）
function syncNav(desired) {
  if (!navBubble || !navCurrent) return;
  if (!desired.some((x) => x.childUid === navCurrent.childUid)) { hideNavBubble(); return; }
  const el = findBlockTextEl(navCurrent.parentUid);
  if (el) positionBubble(navBubble, el);
}
function navGo(dir) {
  const els = navMarks();
  if (!els.length) { updateNavLabel(0); navCurrent = null; hideNavBubble(); updateNavActions(); return; }
  navIdx = (navIdx + dir + els.length) % els.length;
  const el = els[navIdx];
  navScrolling = true;   // 捲動途中別讓 scrollBound 把待彈的導覽泡泡收掉（遠處標記彈不出來的元兇）
  el.scrollIntoView({ block: "center" });   // 即時捲動（smooth 動畫期間 scrollBound 會一直 hideNavBubble）
  const prev = el.style.background; el.style.background = "#ffd54a";
  setTimeout(() => { el.style.background = prev; }, 900);
  navCurrent = el.__ccmMark || null;
  updateNavActions();
  setTimeout(() => { if (navCurrent && document.body.contains(el)) showNavBubble(el, navCurrent); navScrolling = false; }, 180);
  updateNavLabel(els.length);
}
function updateNavLabel(total) { const lbl = navEl && navEl.querySelector(".ccm-nav-label"); if (lbl) lbl.textContent = total ? (navIdx + 1) + "/" + total : "0"; }
// 接受/退回：鍵盤（⌥Enter/⌥R）與右下導覽列 ✅/↩ 鈕共用同一段，行為一致。內容多長都在固定位置點得到，不必碰浮動泡泡。
function navAccept() {
  if (!navCurrent) return;
  if (navCurrent.state === "review") {
    const noteProp = (navCurrent.intent === "查" || navCurrent.intent === "議") && navCurrent.proposal;   // 查/議整合版 → 直接套用
    acceptMark(navCurrent, noteProp ? "apply" : undefined);
    setTimeout(() => navGo(1), 280);   // 接受後自動跳下一個
  } else if (navCurrent.state === "draft") {
    clearDraftTag(navCurrent); setTimeout(() => navGo(1), 280);   // 草稿 → 收編完成
  }
}
function navReject() { if (navCurrent && navCurrent.state === "review") openEdit(navCurrent, findBlockTextEl(navCurrent.parentUid)); }
// 導覽列 ✅/↩ 鈕依目前導覽到的標記狀態顯示：待審→兩顆都給；草稿→只給收編✅；待CC/待處理→沒有可直接接受的動作，藏起來
function updateNavActions() {
  if (!navEl) return;
  const acc = navEl.querySelector(".ccm-nav-acc"), rej = navEl.querySelector(".ccm-nav-rej");
  if (!acc || !rej) return;
  const st = navCurrent && navCurrent.state;
  if (st === "review") { acc.style.display = ""; rej.style.display = ""; acc.title = "接受這個 (⌥Enter)"; }
  else if (st === "draft") { acc.style.display = ""; rej.style.display = "none"; acc.title = "收編完成 (⌥Enter)"; }
  else { acc.style.display = "none"; rej.style.display = "none"; }
}
function toggleNav() { if (!navEl) return; if (navEl.style.display !== "none") { navEl.style.display = "none"; return; } navEl.style.display = "flex"; navIdx = -1; navGo(1); }

// ── 開關 ─────────────────────────────────────────────────────
function setActive(v) { active = v; try { api.settings.set("active", v); } catch (e) {} updateToggle(); if (!v) { hidePanel(); hideTrigger(); } }
function updateToggle() {
  if (!toggleBtn) return;
  toggleBtn.textContent = active ? "✏️ 標記模式：開" : "✏️ 標記模式：關";
  toggleBtn.classList.toggle("on", active);
}

// ── 審稿簾（curtain）：往下審過就把右側握把拉下，簾子蓋住已審區、下緣虛線追蹤進度 ──
function curtainScrollerEl() {
  return document.querySelector(".roam-article") ||
    document.querySelector(".rm-article-wrapper") ||
    document.scrollingElement || document.documentElement;
}
function curtainStartDrag(e) {
  e.preventDefault(); e.stopPropagation(); curtainDragging = true; curtainDragY = e.clientY;
  // 拖曳順暢的關鍵：把 pointer 鎖在握把上。否則游標掃過的每一段都在觸發 hover（Roam 的 bullet 控制列、
  // 我們的標記泡泡）→ DOM 一直變 → MutationObserver → refreshDecorations 跑跨 graph 的 datalog 查詢 → 頓一下。
  curtainCapture = null;
  try { if (e.pointerId != null && e.currentTarget && e.currentTarget.setPointerCapture) { e.currentTarget.setPointerCapture(e.pointerId); curtainCapture = { el: e.currentTarget, id: e.pointerId }; } } catch (err) {}
  removeHoverBubble();
  document.addEventListener("pointermove", curtainDragMove);
  document.addEventListener("pointerup", curtainDragEnd);
  document.addEventListener("pointercancel", curtainDragEnd);
  document.addEventListener("wheel", curtainWheel, { capture: true, passive: false });   // 拖曳中滾輪：捲頁＋線跟游標
}
// 主欄真正的捲動容器：Roam site.css 是 .rm-article-wrapper{height:100%;overflow-y:scroll}；保險起見再往上找一層真的會捲的
function articleScroller() {
  const w = document.querySelector(".rm-article-wrapper");
  if (w && w.scrollHeight > w.clientHeight + 1) return w;
  for (let e = document.querySelector(".roam-article"); e; e = e.parentElement) {
    if (e.scrollHeight > e.clientHeight + 1) {
      let ov = ""; try { ov = getComputedStyle(e).overflowY; } catch (err) {}
      if (ov === "auto" || ov === "scroll") return e;
    }
  }
  return w || document.scrollingElement || document.documentElement;
}
function wheelDeltaPx(e) {
  let d = e.deltaY || 0;
  if (e.deltaMode === 1) d *= 16; else if (e.deltaMode === 2) d *= window.innerHeight;   // 1=行、2=頁 → 換成像素
  return d;
}
// 握把/虛線是 fixed 元素、掛在 body 下不在 .rm-article-wrapper 裡：滾輪打在上面瀏覽器找不到可捲的祖先 → 原本完全不動。
// 這裡代為捲主欄。拖曳中：內容捲走、審稿線留在游標下（往下滾線就往下、往上滾就往上）；非拖曳：線跟內容走（scroll 事件會 positionCurtain）。
function curtainWheel(e) {
  if (!curtainOn) return;
  const sc = articleScroller();
  const before = sc.scrollTop;
  sc.scrollTop = before + wheelDeltaPx(e);
  const moved = sc.scrollTop !== before;
  if (!moved && !curtainDragging) return;   // 到頂/到底：交回瀏覽器
  e.preventDefault(); e.stopPropagation();
  if (moved) { if (curtainDragging) curtainAnchor = curtainContentY(curtainDragY); positionCurtain(); }   // 不等下一幀的 scroll 事件，當下就重定位
}
function buildCurtain() {
  curtainEl = document.createElement("div"); curtainEl.className = "ccm-curtain"; curtainEl.style.display = "none";
  document.body.appendChild(curtainEl);
  // 橫跨寬度的透明拖曳帶，貼在虛線上——整條線都能抓著拉（其餘簾身仍穿透）
  curtainEdge = document.createElement("div"); curtainEdge.className = "ccm-curtain-edge"; curtainEdge.style.display = "none";
  curtainEdge.title = "拖曳這條線＝移動審稿進度";
  curtainEdge.addEventListener("pointerdown", curtainStartDrag);
  curtainEdge.addEventListener("wheel", curtainWheel, { passive: false });   // 滾輪打在虛線上也要能捲頁
  document.body.appendChild(curtainEdge);
  curtainGrip = document.createElement("div"); curtainGrip.className = "ccm-curtain-grip"; curtainGrip.style.display = "none";
  curtainGrip.innerHTML =
    '<span class="ccm-cg-top" title="回到文章最上面，審稿線歸零（從頭開始審）">⤒</span>' +
    '<span class="ccm-cg-op" title="更透明">－</span>' +
    '<span class="ccm-cg-label" title="拖曳＝移動審稿線；數字＝審稿進度（拉到最後一段＝100%）">⬍ 審到這</span>' +
    '<span class="ccm-cg-op" title="更濃">＋</span>' +
    '<span class="ccm-cg-x" title="關閉簾子">✕</span>';
  curtainGrip.querySelector(".ccm-cg-label").addEventListener("pointerdown", curtainStartDrag);
  curtainGrip.addEventListener("wheel", curtainWheel, { passive: false });   // 滾輪打在握把上也要能捲頁
  const ops = curtainGrip.querySelectorAll(".ccm-cg-op");
  ops[0].onclick = (e) => { e.stopPropagation(); setCurtainOpacity(curtainOpacity - 0.06); };
  ops[1].onclick = (e) => { e.stopPropagation(); setCurtainOpacity(curtainOpacity + 0.06); };
  curtainGrip.querySelector(".ccm-cg-x").onclick = (e) => { e.stopPropagation(); setCurtain(false); };
  curtainGrip.querySelector(".ccm-cg-top").onclick = (e) => { e.stopPropagation(); curtainToTop(); };
  document.body.appendChild(curtainGrip);
}
// 回到文章最上面。Roam 主欄真正在捲動的是 .rm-article-wrapper（site.css：height:100%;overflow-y:scroll），
// .roam-article 本身不捲、.roam-body 是 overflow:hidden 所以 window.scrollTo 也沒用（v4 就是押錯這層才沒反應）。
// 做法不押注哪一層：從 .roam-article 往上，每一層有捲動量的祖先都歸零。回傳歸零了幾層（測試用）。
function scrollArticleTop() {
  const start = document.querySelector(".roam-article") || document.querySelector(".rm-article-wrapper") || document.body;
  let n = 0;
  for (let e = start; e; e = e.parentElement) { if (e.scrollTop > 0) { e.scrollTop = 0; n++; } }
  const se = document.scrollingElement; if (se && se.scrollTop > 0) { se.scrollTop = 0; n++; }
  try { window.scrollTo(0, 0); } catch (e) {}
  return n;
}
// ⤒：捲到頂＋審稿線歸零到第一段頂端（0%），這頁記成「從頭開始」。Roam 換頁常沿用上一頁的捲動位置，
// 從儲藏室清單底部點進新稿就落在最下面、簾子還停在舊位置，這顆鈕一次把兩件事歸位。
function curtainToTop() {
  scrollArticleTop();
  curtainRangeCache = null;
  const rng = curtainRange();
  curtainAnchor = rng.start;
  positionCurtain();
  try { api.settings.set("curtainAnchor", Math.round(curtainAnchor)); } catch (e) {}
  const pg = currentOpenUid();
  if (pg) { curtainByPage[pg] = CURTAIN_TOP; saveCurtainPages(); }
  toast("⤒ 回到最上面，審稿線歸零 0%");
}
function setCurtainOpacity(v) {
  curtainOpacity = Math.max(0.08, Math.min(0.7, v));
  positionCurtain();
  try { api.settings.set("curtainOpacity", curtainOpacity); } catch (e) {}
}
function curtainIsDoc(sc) {
  return sc === document.scrollingElement || sc === document.documentElement || sc === document.body;
}
function positionCurtain() {
  if (!curtainOn || !curtainEl) return;
  const sc = curtainScroller || (curtainScroller = curtainScrollerEl());
  const isDoc = curtainIsDoc(sc);
  const rect = sc.getBoundingClientRect();
  const scTop = sc.scrollTop || 0;
  // 內容座標 curtainAnchor → 視窗 Y（div 捲動要加容器偏移，文件捲動直接扣 scrollY，否則會重複扣）
  const baseTop = isDoc ? 0 : rect.top;
  const left = isDoc ? 0 : rect.left;
  const width = isDoc ? window.innerWidth : rect.width;
  let y = baseTop + (curtainAnchor - scTop);
  const top = Math.max(0, baseTop);
  y = Math.max(top, Math.min(window.innerHeight, y));
  curtainEl.style.left = left + "px";
  curtainEl.style.width = width + "px";
  curtainEl.style.top = top + "px";
  curtainEl.style.height = Math.max(0, y - top) + "px";
  curtainEl.style.background = "rgba(122,110,88," + curtainOpacity + ")";
  curtainGrip.style.top = y + "px";
  curtainGrip.style.left = (left + width) + "px";
  curtainEdge.style.top = y + "px";
  curtainEdge.style.left = left + "px";
  curtainEdge.style.width = width + "px";
  // 審稿進度 %：審稿線位置 ÷ 整篇原稿（拉到最後一段底＝100%）
  const rng = curtainRangeCache || (curtainRangeCache = curtainRange());
  let pct = (rng && rng.end > rng.start) ? (curtainAnchor - rng.start) / (rng.end - rng.start) : 0;
  pct = Math.round(Math.max(0, Math.min(1, pct)) * 100);
  const lab = curtainGrip.querySelector(".ccm-cg-label");
  if (lab) lab.textContent = "⬍ " + pct + "%";
}
function curtainDragMove(e) {
  if (!curtainDragging) return;
  const sc = curtainScroller || curtainScrollerEl();
  const baseTop = curtainIsDoc(sc) ? 0 : sc.getBoundingClientRect().top;
  const yv = Math.max(baseTop, Math.min(window.innerHeight, e.clientY));
  curtainDragY = yv;
  curtainAnchor = (sc.scrollTop || 0) + (yv - baseTop);
  positionCurtain();
}
function curtainDragEnd() {
  if (!curtainDragging) return;
  curtainDragging = false;
  document.removeEventListener("pointermove", curtainDragMove);
  document.removeEventListener("pointerup", curtainDragEnd);
  document.removeEventListener("pointercancel", curtainDragEnd);
  document.removeEventListener("wheel", curtainWheel, { capture: true });
  if (curtainCapture) { try { curtainCapture.el.releasePointerCapture(curtainCapture.id); } catch (e) {} curtainCapture = null; }
  if (refreshDeferred) { refreshDeferred = false; debouncedRefresh(); }   // 拖曳期間凍結的 refresh 補跑一次
  try { api.settings.set("curtainAnchor", Math.round(curtainAnchor)); } catch (e) {}
  // 把「審到這條線」錨定到某個 block（穩定、跨螢幕/跨電腦），依「本頁」分開記
  const pg = currentOpenUid();
  if (pg) { curtainByPage[pg] = curtainAnchorBlockUid() || CURTAIN_TOP; saveCurtainPages(); }
}
// 視窗 Y ↔ 內容座標；找出「審稿線上方最後一個 block」＝上次審到的那段
function curtainContentY(viewportY) {
  const sc = curtainScroller || curtainScrollerEl();
  const baseTop = curtainIsDoc(sc) ? 0 : sc.getBoundingClientRect().top;
  return (sc.scrollTop || 0) + (viewportY - baseTop);
}
function curtainFrontierVY() {
  const sc = curtainScroller || curtainScrollerEl();
  const baseTop = curtainIsDoc(sc) ? 0 : sc.getBoundingClientRect().top;
  return baseTop + (curtainAnchor - (sc.scrollTop || 0));
}
function curtainAnchorBlockUid() {
  const fy = curtainFrontierVY();
  let best = null, bestBottom = -Infinity;
  document.querySelectorAll(".rm-block-text, .roam-block").forEach((el) => {
    if (!el.id) return;
    const u = uidFromId(el); if (!u) return;
    const b = el.getBoundingClientRect().bottom;
    if (b <= fy + 4 && b > bestBottom) { bestBottom = b; best = u; }
  });
  return best;
}
// 原稿頭尾（第一段頂→最後一段底）的內容座標，用來算審稿進度 %
function curtainRange() {
  let minTop = Infinity, maxBot = -Infinity;
  document.querySelectorAll(".rm-block-text, .roam-block").forEach((el) => {
    if (!el.id || !uidFromId(el)) return;
    const r = el.getBoundingClientRect();
    if (!r.height) return;
    const t = curtainContentY(r.top), b = curtainContentY(r.bottom);
    if (t < minTop) minTop = t;
    if (b > maxBot) maxBot = b;
  });
  if (maxBot <= minTop) { const sc = curtainScroller || curtainScrollerEl(); return { start: 0, end: sc.scrollHeight || 1 }; }
  return { start: Math.max(0, minTop), end: maxBot };
}
function saveCurtainPages() {
  const keys = Object.keys(curtainByPage);
  if (keys.length > 120) for (const k of keys.slice(0, keys.length - 120)) delete curtainByPage[k];
  try { api.settings.set("curtainPages", JSON.stringify(curtainByPage)); } catch (e) {}
}
function restoreCurtainForPage() {
  if (!curtainOn) return false;
  const pg = currentOpenUid(); if (!pg) return false;
  const u = curtainByPage[pg]; if (!u) return false;
  if (u === CURTAIN_TOP) {
    if (!document.querySelector(".rm-block-text, .roam-block")) return false;   // 本頁還沒渲染 → 待重試
    curtainRangeCache = null; curtainAnchor = curtainRange().start; positionCurtain(); return true;
  }
  const el = findBlockTextEl(u); if (!el) return false;   // 該段還沒渲染（收合/未捲到）→ 待重試
  curtainAnchor = curtainContentY(el.getBoundingClientRect().bottom);
  positionCurtain();
  return true;
}
function setCurtain(on) {
  curtainOn = on;
  try { api.settings.set("curtain", on); } catch (e) {}
  if (curtainBtn) { curtainBtn.classList.toggle("on", on); curtainBtn.textContent = on ? "🪟 審稿簾：開" : "🪟 審稿簾"; }
  curtainEl.style.display = on ? "block" : "none";
  curtainGrip.style.display = on ? "flex" : "none";
  curtainEdge.style.display = on ? "block" : "none";
  if (on) { curtainScroller = curtainScrollerEl(); curtainPageUid = currentOpenUid(); positionCurtain(); if (!restoreCurtainForPage()) setTimeout(restoreCurtainForPage, 600); }
}

// ── style ────────────────────────────────────────────────────
function injectStyle() {
  styleEl = document.createElement("style");
  styleEl.textContent = `
  .ccm-underline{background:#fff2c9;border-bottom:2px solid #f0a020;border-radius:2px;padding:0 1px;cursor:pointer;transition:background .12s;}
  .ccm-underline:hover{background:#ffe79a;}
  .ccm-underline-review{background:#d7f5e3;border-bottom:2px solid #22a06b;border-radius:2px;padding:0 1px;cursor:pointer;}
  .ccm-underline-review:hover{background:#bff0d4;}
  .ccm-block-flag{box-shadow:-3px 0 0 #f0a020;background:#fffaf0;}
  .ccm-block-flag-review{box-shadow:-3px 0 0 #22a06b;background:#f0fbf5;}
  .ccm-underline-draft{background:#e7e9ff;border-bottom:2px solid #6a5acd;border-radius:2px;padding:0 1px;}
  .ccm-block-flag-draft{box-shadow:-3px 0 0 #6a5acd;background:#f5f4ff;}
  .ccm-bubble.draft{border-color:#b7b0ee;}
  .ccm-bubble.draft .ccm-lbl{color:#5a4bc4;}
  .ccm-bubble.draft::after{filter:drop-shadow(0 1px 0 #b7b0ee);}
  /* 標記列＝可見（原本 display:none，2026-08-28 改）。只做視覺區分，內容一律看得到 */
  .ccm-mark-row{background:#fffaf0;box-shadow:inset 3px 0 0 #f0a020;border-radius:4px;}
  .ccm-overlay{position:absolute;top:0;left:0;width:0;height:0;z-index:9990;pointer-events:none;}
  .ccm-bubble{position:absolute;width:max-content;max-width:280px;background:#fff;border:1px solid #f0c453;border-radius:9px;
    box-shadow:0 6px 20px rgba(16,22,26,.18);padding:7px 11px 8px;font-size:12.5px;line-height:1.5;color:#33404d;
    transform:translate(-50%,-100%);pointer-events:auto;z-index:9991;
    display:flex;flex-direction:column;max-height:calc(100vh - 20px);box-sizing:border-box;}
  .ccm-bubble.review{border-color:#8ad9b3;}
  .ccm-bubble .ccm-lbl{flex:none;white-space:nowrap;font-size:10.5px;font-weight:800;color:#b5820c;margin-bottom:2px;}
  .ccm-bubble.review .ccm-lbl{color:#1a7f54;}
  .ccm-bubble .ccm-ins{flex:0 1 auto;min-height:0;overflow-y:auto;font-weight:600;white-space:normal;}
  .ccm-bubble.review{max-width:340px;}
  .ccm-bubble.ccm-pinned{box-shadow:0 10px 30px rgba(16,22,26,.3);outline:2px solid rgba(34,160,107,.4);}
  .ccm-diff{flex:0 1 auto;min-height:0;display:flex;flex-direction:column;margin:3px 0 2px;border:1px solid #e6ebf0;border-radius:7px;overflow-y:auto;}
  .ccm-drow{display:flex;gap:6px;padding:5px 8px;font-size:12.5px;line-height:1.5;white-space:normal;}
  .ccm-drow+.ccm-drow{border-top:1px dashed #d8dee5;}
  .ccm-drow.old{background:#fdecec;}
  .ccm-drow.new{background:#e8f7ef;}
  .ccm-drow.note{background:#fff8e6;}
  .ccm-dtag{flex:none;font-size:10px;font-weight:800;padding:1px 5px;border-radius:5px;height:fit-content;margin-top:1px;}
  .ccm-drow.old .ccm-dtag{background:#f6c9cb;color:#a4282d;}
  .ccm-drow.old .ccm-dtext{color:#8a5a5c;text-decoration:line-through;text-decoration-color:#dd9a9c;}
  .ccm-drow.new .ccm-dtag{background:#b7ebcf;color:#137a4e;}
  .ccm-drow.note .ccm-dtag{background:#f4dfa0;color:#8a6d1c;}
  .ccm-dtext{color:#33404d;}
  .ccm-bubble::after{content:"";position:absolute;left:50%;bottom:-7px;transform:translateX(-50%);border:7px solid transparent;border-top-color:#fff;filter:drop-shadow(0 1px 0 #f0c453);}
  .ccm-bubble.review::after{filter:drop-shadow(0 1px 0 #8ad9b3);}
  .ccm-bubble.ccm-below{transform:translate(-50%,0);}
  .ccm-bubble.ccm-below::after{top:-7px;bottom:auto;border-top-color:transparent;border-bottom-color:#fff;filter:drop-shadow(0 -1px 0 #f0c453);}
  .ccm-bubble.review.ccm-below::after{border-bottom-color:#fff;filter:drop-shadow(0 -1px 0 #8ad9b3);}
  .ccm-bubble.ccm-clamped::after{display:none;}   /* 被夾回視窗內時箭頭不再對準文字，藏起來免得指向空白 */
  .ccm-bubble .ccm-bactions{flex:none;display:flex;gap:6px;margin-top:7px;}
  .ccm-bubble .ccm-bactions button{font-size:11px;cursor:pointer;border-radius:6px;padding:3px 11px;border:1px solid transparent;font-weight:700;}
  .ccm-bedit,.ccm-acc{background:#2b7de0;color:#fff;}
  .ccm-acc{background:#22a06b;}
  .ccm-bedit:hover{background:#1e6fd0;} .ccm-acc:hover{background:#1a8558;}
  .ccm-bdel,.ccm-ret{background:#fff;color:#e5484d;border:1px solid #f3c0c2 !important;}
  .ccm-ret{color:#8a6d3b;border-color:#e5cf9e !important;}
  .ccm-bdel:hover,.ccm-ret:hover{background:#fbf4e8;}
  .ccm-improve{background:#fff;color:#2b7de0;border:1px solid #bcd6f5 !important;}
  .ccm-improve:hover{background:#f0f6fe;}
  .ccm-clear{background:#f0f2f5;color:#58636e;}
  .ccm-clear:hover{background:#e4e8ed;}
  .ccm-trigger{position:absolute;z-index:9996;display:flex;gap:6px;white-space:nowrap;transform:translate(-50%,-100%);}
  .ccm-trig-btn{background:#2b7de0;color:#fff;font-size:12px;font-weight:700;padding:4px 10px;border-radius:999px;box-shadow:0 4px 14px rgba(16,22,26,.22);cursor:pointer;user-select:none;}
  .ccm-trig-btn:hover{background:#1e6fd0;}
  .ccm-trig-insert{background:#22a06b;}
  .ccm-trig-insert:hover{background:#1a8558;}
  .ccm-trig-photo{background:#7c5cff;}
  .ccm-trig-photo:hover{background:#6a49f2;}
  .ccm-panel{position:absolute;z-index:9995;width:300px;background:#fff;border:1px solid #d5dbe2;border-radius:11px;box-shadow:0 10px 30px rgba(16,22,26,.22);padding:11px 12px 12px;transform:translateX(-50%);}
  .ccm-panel .ccm-head{font-size:12px;font-weight:800;color:#2b7de0;margin-bottom:7px;}
  .ccm-intents{display:flex;gap:6px;margin-bottom:5px;}
  .ccm-intents button{flex:1;font-size:13px;font-weight:800;cursor:pointer;border:1px solid #dbe1e8;background:#f7f9fb;border-radius:7px;padding:5px 0;color:#4a5560;}
  .ccm-intents button.on{background:#2b7de0;color:#fff;border-color:#2b7de0;}
  .ccm-hint{font-size:11px;color:#98a2ac;margin-bottom:7px;}
  .ccm-panel .ccm-picked{font-size:11.5px;color:#8a94a0;background:#f4f6f8;border-radius:6px;padding:4px 7px;margin-bottom:8px;max-height:42px;overflow:hidden;}
  .ccm-panel .ccm-picked.ccm-picked-warn{color:#8a4b00;background:#fff4d6;border:1px solid #f0a020;font-weight:600;max-height:none;}
  .ccm-ref{display:none;font-size:11.5px;color:#1a7f54;background:#eefaf3;border:1px solid #cdeeda;border-radius:6px;padding:5px 8px;margin-bottom:8px;line-height:1.5;max-height:72px;overflow:auto;}
  .ccm-panel textarea{width:100%;min-height:50px;resize:vertical;border:1px solid #d5dbe2;border-radius:7px;padding:7px 8px;font-size:13px;font-family:inherit;line-height:1.5;outline:none;box-sizing:border-box;}
  .ccm-panel textarea:focus{border-color:#2b7de0;box-shadow:0 0 0 3px rgba(43,125,224,.12);}
  .ccm-chips{display:flex;flex-wrap:wrap;gap:5px;margin:8px 0;}
  .ccm-chips span{font-size:11.5px;cursor:pointer;border:1px solid #dbe1e8;background:#f7f9fb;border-radius:999px;padding:3px 9px;color:#4a5560;}
  .ccm-chips span:hover{background:#2b7de0;color:#fff;border-color:#2b7de0;}
  .ccm-actions{display:flex;gap:7px;margin-top:4px;align-items:center;}
  .ccm-actions button{font-size:12.5px;cursor:pointer;border-radius:7px;padding:5px 12px;border:1px solid transparent;}
  .ccm-delete{margin-right:auto;background:#fff;color:#e5484d;border:1px solid #f3c0c2 !important;}
  .ccm-delete:hover{background:#fdecec;}
  .ccm-cancel{background:#f0f2f5;color:#58636e;}
  .ccm-save{background:#2b7de0;color:#fff;font-weight:700;} .ccm-save:hover{background:#1e6fd0;}
  .ccm-pill{position:fixed;right:18px;bottom:58px;z-index:9994;background:#fff;border:1px solid #f6d67a;color:#92660b;font-size:12.5px;padding:6px 13px;border-radius:999px;box-shadow:0 4px 14px rgba(16,22,26,.14);cursor:pointer;}
  .ccm-pill b{color:#c47f0a;} .ccm-pill .ccm-rev{color:#1a7f54;font-weight:700;} .ccm-pill .ccm-draft{color:#5a4bc4;font-weight:700;}
  .ccm-nav{position:fixed;right:18px;bottom:98px;z-index:9994;display:flex;align-items:center;gap:6px;background:#fff;border:1px solid #d5dbe2;border-radius:999px;padding:4px 8px;box-shadow:0 4px 14px rgba(16,22,26,.16);}
  .ccm-nav button{width:26px;height:26px;border:none;border-radius:50%;background:#eef2f6;color:#37424d;cursor:pointer;font-size:12px;line-height:1;}
  .ccm-nav button:hover{background:#2b7de0;color:#fff;}
  .ccm-nav button.ccm-nav-acc{background:#e3f6ec;}
  .ccm-nav button.ccm-nav-acc:hover{background:#22a06b;color:#fff;}
  .ccm-nav button.ccm-nav-rej{background:#fbeede;}
  .ccm-nav button.ccm-nav-rej:hover{background:#e0a94b;color:#fff;}
  .ccm-nav-label{font-size:12px;font-weight:700;color:#58636e;min-width:34px;text-align:center;}
  .ccm-fabrow{position:fixed;right:18px;bottom:18px;z-index:9994;display:flex;align-items:center;gap:8px;}
  .ccm-fab-btn{font-size:12.5px;font-weight:700;padding:6px 13px;border-radius:999px;box-shadow:0 4px 14px rgba(16,22,26,.14);cursor:pointer;user-select:none;white-space:nowrap;}
  .ccm-toggle{background:#e9edf1;border:1px solid #d5dbe2;color:#58636e;transition:background .12s;}
  .ccm-toggle.on{background:#2b7de0;border-color:#2b7de0;color:#fff;box-shadow:0 4px 16px rgba(43,125,224,.35);}
  .ccm-curtain-btn{background:#efeadf;border:1px solid #d9cfb6;color:#8a6d3b;}
  .ccm-curtain-btn.on{background:#8a6d3b;border-color:#8a6d3b;color:#fff;box-shadow:0 4px 16px rgba(138,109,59,.35);}
  .ccm-hugo-btn{background:#e8f2ec;border:1px solid #b7dcc7;color:#1a7f54;}
  .ccm-hugo-btn:hover{background:#d7ecdf;}
  .ccm-rc-hint{color:#7a8896;font-size:11px;}
  .ccm-reformat-btn{background:#e8eef8;border:1px solid #b7c9e4;color:#2b5da0;}
  .ccm-reformat-btn:hover{background:#dbe6f4;}
  .ccm-reformat-btn.on{background:#2b5da0;border-color:#2b5da0;color:#fff;box-shadow:0 4px 16px rgba(43,93,160,.35);}
  .ccm-reformat-card{position:fixed;right:18px;bottom:60px;z-index:9995;width:330px;max-width:calc(100vw - 36px);background:#fff;border:1px solid #b7c9e4;border-radius:12px;box-shadow:0 12px 34px rgba(16,22,26,.24);padding:12px 14px 13px;font-size:12.5px;line-height:1.55;color:#33404d;box-sizing:border-box;max-height:calc(100vh - 90px);overflow-y:auto;}
  .ccm-reformat-card .ccm-rc-head{font-size:12.5px;font-weight:800;color:#2b5da0;margin-bottom:7px;display:flex;align-items:center;justify-content:space-between;}
  .ccm-rc-x{cursor:pointer;color:#98a2ac;font-weight:700;padding:0 2px;}
  .ccm-rc-x:hover{color:#e5484d;}
  .ccm-rc-status{font-size:12px;color:#58636e;background:#f4f6f9;border-radius:7px;padding:5px 8px;margin-bottom:7px;}
  .ccm-rc-warn{font-size:12px;color:#a4600b;background:#fdf3e2;border:1px solid #f0d9a8;border-radius:7px;padding:5px 8px;margin-bottom:8px;}
  .ccm-rc-ok{font-size:12px;color:#1a7f54;background:#eef9f2;border:1px solid #bfe6cf;border-radius:7px;padding:5px 8px;margin-bottom:8px;font-weight:700;}
  .ccm-rc-verify{font-size:12px;border-radius:7px;padding:5px 8px;margin-bottom:8px;font-weight:600;}
  .ccm-rc-verify.ok{color:#1a7f54;background:#eef9f2;border:1px solid #bfe6cf;}
  .ccm-rc-verify.bad{color:#a4282d;background:#fdecec;border:1px solid #f3c0c2;}
  .ccm-rc-diff{margin-top:4px;display:flex;flex-direction:column;gap:3px;font-weight:500;}
  .ccm-rc-diff .old{color:#8a5a5c;}
  .ccm-rc-diff .new{color:#137a4e;}
  .ccm-rc-suggest{font-size:12px;color:#8a6d1c;background:#fff8e6;border:1px solid #f0e0b0;border-radius:7px;padding:5px 8px;margin-bottom:8px;}
  .ccm-rc-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;}
  .ccm-rc-actions button{font-size:11.5px;cursor:pointer;border-radius:7px;padding:5px 11px;border:1px solid transparent;font-weight:700;}
  .ccm-rc-pack,.ccm-rc-apply,.ccm-rc-restore{background:#2b5da0;color:#fff;}
  .ccm-rc-pack:hover,.ccm-rc-apply:hover,.ccm-rc-restore:hover{background:#224e8a;}
  .ccm-rc-compare{background:#eef2f8;color:#2b5da0;border:1px solid #c7d6ec !important;}
  .ccm-rc-compare:hover{background:#e0e9f5;}
  .ccm-rc-return,.ccm-rc-clear{background:#fff;color:#e5484d;border:1px solid #f3c0c2 !important;}
  .ccm-rc-return:hover,.ccm-rc-clear:hover{background:#fdecec;}
  .ccm-rc-disabled{opacity:.5;cursor:not-allowed !important;}
  .ccm-curtain{position:fixed;z-index:9985;pointer-events:none;border-bottom:2px dashed rgba(90,78,52,.85);}
  .ccm-curtain-edge{position:fixed;z-index:9986;height:14px;transform:translateY(-50%);pointer-events:auto;cursor:ns-resize;background:transparent;}
  .ccm-curtain-edge:hover{background:rgba(138,109,59,.18);}
  .ccm-curtain-grip{position:fixed;z-index:9986;transform:translate(-100%,-50%);display:flex;align-items:center;gap:2px;background:#8a6d3b;color:#fff;font-size:11px;font-weight:800;padding:3px 5px 3px 7px;border-radius:9px 0 0 9px;box-shadow:0 2px 8px rgba(0,0,0,.28);user-select:none;white-space:nowrap;}
  .ccm-curtain-grip .ccm-cg-label{cursor:ns-resize;padding:0 4px;}
  .ccm-curtain-grip .ccm-cg-op,.ccm-curtain-grip .ccm-cg-x,.ccm-curtain-grip .ccm-cg-top{cursor:pointer;width:17px;height:17px;line-height:17px;text-align:center;border-radius:5px;background:rgba(255,255,255,.16);font-size:12px;}
  .ccm-curtain-grip .ccm-cg-op:hover,.ccm-curtain-grip .ccm-cg-x:hover,.ccm-curtain-grip .ccm-cg-top:hover{background:rgba(255,255,255,.32);}
  .ccm-curtain-grip .ccm-cg-top{margin-right:3px;font-size:13px;}
  .ccm-toast{position:fixed;left:50%;bottom:46px;transform:translateX(-50%);z-index:9998;background:#1f2937;color:#fff;font-size:12.5px;font-weight:600;padding:8px 16px;border-radius:999px;box-shadow:0 6px 20px rgba(16,22,26,.3);opacity:1;transition:opacity .4s;pointer-events:none;}
  `;
  document.head.appendChild(styleEl);
}

// ── observer ─────────────────────────────────────────────────
function startObserver() {
  const root = document.querySelector(".roam-app") || document.body;
  observer = new MutationObserver(() => { if (applying) return; debouncedRefresh(); });
  observer.observe(root, { childList: true, subtree: true, characterData: true });
  scrollBound = (e) => { if (e && e.type === "resize") curtainRangeCache = null; if (!navScrolling) hideNavBubble(); positionCurtain(); debouncedRefresh(); };
  window.addEventListener("scroll", scrollBound, true);
  window.addEventListener("resize", scrollBound);
}

// ── lifecycle ────────────────────────────────────────────────
function onload({ extensionAPI }) {
  api = extensionAPI;
  injectStyle();
  buildUI();
  active = api.settings.get("active") === true;
  updateToggle();
  const ca = api.settings.get("curtainAnchor"); if (typeof ca === "number") curtainAnchor = ca;
  const co = api.settings.get("curtainOpacity"); if (typeof co === "number") curtainOpacity = co;
  try { const s = api.settings.get("curtainPages"); if (s) curtainByPage = JSON.parse(s) || {}; } catch (e) { curtainByPage = {}; }
  setCurtain(api.settings.get("curtain") === true);
  document.addEventListener("mouseup", onMouseUp);
  keyBound = onKeyDown; document.addEventListener("keydown", keyBound, true);
  mdBound = (e) => {
    if (navBubble && !navBubble.contains(e.target)) hideNavBubble();
    if (pinnedBubble && !pinnedBubble.contains(e.target)) unpinBubble();
  };
  document.addEventListener("mousedown", mdBound, true);
  // Blog Composer picker 彈窗挑完照片 → postMessage 回來，插進原稿
  photoMsgBound = (e) => {
    if (e.origin !== BC_URL) return;
    const d = e.data;
    if (d && d.type === "bc-photo") insertPhotoBlock(d);
  };
  window.addEventListener("message", photoMsgBound);
  startObserver();
  const cmds = [
    { label: "請CC修改：開關標記模式", callback: () => setActive(!active) },
    { label: "請CC修改：標記游標處 (⌥M)", callback: () => { const p = keyboardAnchorXY(); markFromSelection(p.x, p.y, true); } },
    { label: "請CC修改：在游標 block 後插入新段 (⌥N)", callback: () => { const p = keyboardAnchorXY(); markFromSelection(p.x, p.y, true, "接"); } },
    { label: "請CC修改：下一個 (⌥↓)", callback: () => navGo(1) },
    { label: "請CC修改：上一個 (⌥↑)", callback: () => navGo(-1) },
    { label: "請CC修改：打包本頁待處理給 CC", callback: () => copyMarksPrompt() },
    { label: "請CC修改：打包『轉 Hugo 成稿』給 CC", callback: () => copyHugoPrompt() },
    { label: "請CC修改：打包『整篇重排版』給 CC", callback: () => copyReformatPrompt() },
    { label: "請CC修改：套用排版提案", callback: () => applyReformat() },
    { label: "請CC修改：還原排版前備份", callback: () => restoreReformatBackup() },
    { label: "請CC修改：審稿簾 開/關", callback: () => setCurtain(!curtainOn) },
    { label: "請CC修改：回到文章最上面", callback: () => (curtainOn ? curtainToTop() : scrollArticleTop()) },
    { label: "請CC修改：重整標記", callback: () => refreshDecorations(true) },
  ];
  cmds.forEach((c) => window.roamAlphaAPI.ui.commandPalette.addCommand(c));
  setTimeout(() => refreshDecorations(true), 400);
  console.log("[請CC修改] v11 loaded — 📐 排版依據換成 Bear 的敘事骨架；標題只准『升格他自己的句子』或『路標白名單』，CC 不准造標題");
  console.log(`[請CC修改] extension ${CCM_VERSION} 已載入 — ${CCM_VERSION_NOTE}`);
  setTimeout(() => toast(`請CC修改 ${CCM_VERSION} 已載入：${CCM_VERSION_NOTE}`), 600);   // 載入確認：看到這則＝新碼真的上了
}
function onunload() {
  document.removeEventListener("mouseup", onMouseUp);
  if (keyBound) document.removeEventListener("keydown", keyBound, true);
  if (mdBound) document.removeEventListener("mousedown", mdBound, true);
  if (photoMsgBound) window.removeEventListener("message", photoMsgBound);
  if (photoPopup && !photoPopup.closed) { try { photoPopup.close(); } catch (e) {} }
  if (observer) observer.disconnect();
  if (scrollBound) { window.removeEventListener("scroll", scrollBound, true); window.removeEventListener("resize", scrollBound); }
  unpinBubble(); hideNavBubble(); closeReformatCard();
  clearDecorations();
  if (curtainDragging) { document.removeEventListener("pointermove", curtainDragMove); document.removeEventListener("pointerup", curtainDragEnd); document.removeEventListener("pointercancel", curtainDragEnd); document.removeEventListener("wheel", curtainWheel, { capture: true }); if (curtainCapture) { try { curtainCapture.el.releasePointerCapture(curtainCapture.id); } catch (e) {} curtainCapture = null; } }
  [styleEl, overlayEl, panelEl, pillEl, triggerBtn, fabRow, navEl, curtainEl, curtainGrip, curtainEdge, reformatCard].forEach((e) => e && e.remove());
  const labels = ["請CC修改：開關標記模式", "請CC修改：標記游標處 (⌥M)", "請CC修改：在游標 block 後插入新段 (⌥N)", "請CC修改：下一個 (⌥↓)", "請CC修改：上一個 (⌥↑)", "請CC修改：打包本頁待處理給 CC", "請CC修改：打包『轉 Hugo 成稿』給 CC", "請CC修改：打包『整篇重排版』給 CC", "請CC修改：套用排版提案", "請CC修改：還原排版前備份", "請CC修改：審稿簾 開/關", "請CC修改：回到文章最上面", "請CC修改：重整標記"];
  try { labels.forEach((l) => window.roamAlphaAPI.ui.commandPalette.removeCommand({ label: l })); } catch (e) {}
  console.log("[請CC修改] unloaded");
}

export default { onload, onunload };
