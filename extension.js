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
let curtainAnchor = 240, curtainOpacity = 0.4, curtainDragging = false, curtainScroller = null;
let curtainByPage = {}, curtainPageUid = null, curtainRangeCache = null;   // 每頁各自記「審到哪個 block」＋原稿頭尾範圍（算進度%）

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
  const insRaw = seg("【指令】", "【第", "【原文】", "【提案】", "【備註】");
  if (insRaw != null) {
    const im = insRaw.match(/^(潤|接|查|議)\s*[:：]?\s*([\s\S]*)$/);
    if (im) { intent = im[1]; detail = im[2].trim(); } else detail = insRaw;
  }
  const occ = s.match(/【第(\d+)處】/);
  return {
    state: review ? "review" : "todo", intent, instruction: detail,
    occurrence: occ ? parseInt(occ[1], 10) : 1,
    quote: unquote(seg("【原文】", "【提案】", "【備註】")),
    proposal: unquote(seg("【提案】", "【備註】")),
    note: seg("【備註】") || "",
  };
}
function markString(intent, instruction, quote, occurrence) {
  const head = instruction ? `${intent}：${instruction}` : intent;
  let s = `#${TODO_TAG} 【指令】${head}`;
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
  document.querySelectorAll(".ccm-mark-hidden").forEach((e) => e.classList.remove("ccm-mark-hidden"));
  overlayEl.innerHTML = "";
  hoverBubble = null; hoverAnchor = null;   // navBubble 在 body、不在 overlay，別在這裡清（交給 syncNav）
  if (hoverHideT) { clearTimeout(hoverHideT); hoverHideT = null; }
}

// 把「標記 child block」那一列藏起來（只藏顯示、資料不動；inline 手打 tag 的不藏，那是正文）
function hideChildBlock(childUid) {
  const el = findBlockTextEl(childUid);
  if (!el) return;
  const c = el.closest(".roam-block-container") || el.closest(".rm-block");
  if (c) c.classList.add("ccm-mark-hidden");
}

function refreshDecorations(force) {
  if (!overlayEl) return;
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
  for (const m of desired) { const el = findBlockTextEl(m.parentUid); if (el) decorateMark(el, m); if (!m.inline) hideChildBlock(m.childUid); }
  updatePill(todoCount, reviewCount, draftCount);
  updateReformatBtn(pageUid);
  syncPinned(desired); syncNav(desired);
  setTimeout(() => { applying = false; }, 0);
}
const debouncedRefresh = () => { clearTimeout(debounceTimer); debounceTimer = setTimeout(refreshDecorations, 250); };

// ── 建立 / 修改 / 刪除 / 接受 ───────────────────────────────
async function createMark(parentUid, intent, instruction, quote, occurrence) {
  const uid = window.roamAlphaAPI.util.generateUID();
  await window.roamAlphaAPI.createBlock({ location: { "parent-uid": parentUid, order: "last" }, block: { string: markString(intent, instruction, quote, occurrence), uid } });
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
    } else if (replace && m.proposal) {
      const curStr = blockString(m.parentUid);
      let next;
      if (m.quote) { next = replaceNth(curStr, m.quote, m.proposal, m.occurrence); if (next === null) return toast("找不到原文，未套用（原稿可能已被改）"); }
      else next = m.proposal;
      await window.roamAlphaAPI.updateBlock({ block: { uid: m.parentUid, string: next } });
      await window.roamAlphaAPI.deleteBlock({ block: { uid: m.childUid } });
      toast("已接受並套用");
    } else if (!mode && m.intent === "接" && m.proposal) {
      const pos = siblingAfter(m.parentUid);
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
    if (uids.length > 1) return { marks: uids.map((u) => ({ parentUid: u, quote: "", occurrence: 1 })), label: uids.length + " 個段落（整段）" };
    const container = findBlockTextEl(startUid) || startEl;
    const off = offsetInContainer(container, range.startContainer, range.startOffset);
    const occ = occurrenceOf(container.textContent || "", t, off);
    return { marks: [{ parentUid: startUid, quote: t, occurrence: occ }], label: "「" + t + "」" };
  }
  return null;
}

function selectionRect() {
  const sel = window.getSelection();
  if (sel && sel.rangeCount && !sel.isCollapsed) {
    const r = sel.getRangeAt(0).getBoundingClientRect();
    if (r.width || r.height) return r;
  }
  return null;
}
function markFromSelection(x, y, viaKeyboard, forceIntent) {
  const cap = captureSelection(viaKeyboard);
  if (!cap) { hidePanel(); hideTrigger(); return false; }
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
  setTimeout(() => markFromSelection(e.pageX, e.pageY, false), 10);
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
  panelEl.querySelector(".ccm-chips").style.display = it === "潤" ? "flex" : "none";
}
function showTrigger(x, y) { triggerBtn.style.display = "flex"; triggerBtn.style.left = clampX(x, triggerBtn.offsetWidth) + "px"; triggerBtn.style.top = y + "px"; }
function hideTrigger() { if (triggerBtn) triggerBtn.style.display = "none"; }
function showPanel(x, y, label, prefill, ref) {
  const isEdit = pending && pending.mode === "edit";
  panelEl.querySelector(".ccm-head").textContent = isEdit ? "✏️ 修改標記" : "✏️ 請CC修改";
  panelEl.querySelector(".ccm-picked").textContent = label;
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
  else for (const m of p.marks) await createMark(m.parentUid, panelIntent, ins, m.quote, m.occurrence);
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
async function copyHugoPrompt() {
  const pg = currentPage(); if (!pg) return toast("找不到目前頁面");
  const todo = countTagOnPage(TODO_TAG, pg.uid) + countTagOnPage(PROP_TAG, pg.uid);
  const draft = countTagOnPage(DRAFT_TAG, pg.uid);
  const ready = todo === 0 && draft === 0;
  const text =
    `【轉 Hugo · 成稿任務】\n` +
    `行為法典（第一步務必讀）：\n` +
    `  1. 本機 /Users/tsaojian-hsiung/Desktop/Claude Code專用檔/roam-cc-mark/PROTOCOL.md（§七 轉 Hugo 兩個歸零＋§八 聲音守則；備援 raw：https://raw.githubusercontent.com/agoodbear/roam-cc-mark/main/PROTOCOL.md）\n` +
    `  2. 照片解析：本機 /Users/tsaojian-hsiung/Desktop/Claude Code專用檔/blog-composer/ROAM-REFS.md\n` +
    `對象：Roam page「${pg.title}」（page uid: ${pg.uid}）\n` +
    `本頁狀態：待處理／待審標記 ${todo}、#cc草稿 ${draft}${ready ? "（已雙歸零，可轉）" : "（未歸零，請先擋下並列出）"}\n\n` +
    `步驟：\n` +
    `1. 讀上面兩份法典。\n` +
    `2. 用 Roam MCP 讀整頁 ${pg.uid}（含所有 block；素材／背景子樹一併看，轉稿時排除）。\n` +
    `3. 檢查兩個歸零：① #請cc修改／#cc提案 標記＝0 ② #cc草稿＝0。不滿足→列出擋下、不轉。\n` +
    `4. 照片：抓草稿裡所有 composer.agoodbear.com/r/<refId> → POST http://localhost:8765/api/roam-ref-fetch {"refIds":[…]} 換原檔 → 走 Hugo 媒材管線（照片縮 1600、HEIC→JPG 驗方向、影片有 trim 裁該段 1080p+poster、PDF 拆解）。\n` +
    `5. 產 content/posts/<type>-post-N.md（Hugo 禁 H1；沿用 ecg／study／travel／erlife-post-N 慣例；跑 zhtw-mcp lint；#cc草稿 出身段落過 /de-ai-zhtw，Bear 原文不進）。\n` +
    `6. Bear review → 部署草稿 → 回 Roam 頁首寫「✅ 已發佈 → <url> <日期>」。\n` +
    `（更多脈絡：查 Supabase handovers 最近幾筆這篇的紀錄；遵守 bundle_hugo_blog_ops。）`;
  try { await navigator.clipboard.writeText(text); toast(ready ? "已複製「轉 Hugo」任務 ✅ 本頁已雙歸零，貼到新的 CC session" : `已複製「轉 Hugo」任務（本頁還有 ${todo} 標記／${draft} 草稿未清，CC 會擋下）`); }
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
// 頁面 top-level 正文樹 → 深度優先攤平成字串陣列（過濾特殊 root）。驗證用；順序＝:block/order
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
  const summaryNode = find("【變更摘要】"), suggestNode = find("【建議】"), resultNode = find("【重排結果】");
  const flat = [];
  if (resultNode) { const walk = (n) => { flat.push(n[":block/string"] || ""); for (const c of sortKids(n)) walk(c); }; for (const c of sortKids(resultNode)) walk(c); }
  return {
    rootUid, rootStr: (tree && tree[":block/string"]) || "",
    summaryStr: summaryNode ? (summaryNode[":block/string"] || "") : "",
    suggestStr: suggestNode ? (suggestNode[":block/string"] || "") : "",
    resultUid: resultNode && resultNode[":block/uid"], resultNode, proposalTexts: flat,
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
  return { ok: textOk && counts.ok, textOk, firstDiff, counts };
}

// ── 日期／小工具 ──
function reformatStamp() { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; }
function reformatDate() { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
function escapeHtml(s) { return (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function tokenLabel(k) { return { link: "[[連結]]", blockref: "((引用))", highlight: "^^highlight^^", render: "{{元件}}", image: "圖片" }[k] || k; }

// ── 打包「整篇重排版」任務給新開的 Claude Code（閘門比轉Hugo 更嚴：未歸零就不複製）──
async function copyReformatPrompt() {
  const pg = currentPage(); if (!pg) return toast("找不到目前頁面");
  const todo = countTagOnPage(TODO_TAG, pg.uid) + countTagOnPage(PROP_TAG, pg.uid);
  const draft = countTagOnPage(DRAFT_TAG, pg.uid);
  if (todo || draft) return toast(`未歸零：還有 ${todo} 個標記／${draft} 個草稿，先清完才能打包重排`);   // 就地擋掉、不寫剪貼簿
  if (queryReformatProposal(pg.uid)) return toast("本頁已有排版提案，先套用或退回再重排");
  if (pageHasPublished(pg.uid)) return toast("本頁已發佈封存，排版請直接改 Hugo");
  const text =
`【整篇重排版 · 排版任務】
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
3. 在頁面「最底部」建一個 top-level block：「#cc排版提案 【整篇重排版】${reformatDate()}」，其下：
   - 子 block「【變更摘要】標題 +N｜切分 N｜合併 N｜加粗 N｜清空行 N」，其子層逐條列明細
     （每個新標題全文、每處合併/切分/加粗的位置與原文前 10 字）。
   - 子 block「【建議】」：需改字才能解的排版問題，只建議不動手（沒有就寫「無」）。
   - 子 block「【重排結果】」：其直接子層＝重排後的完整正文樹（每個頂層段落一個 block，
     標題 block 用 ##/### 前綴，層級用縮排）。
4. 回 chat 一份對帳清單：各章標題＋每類變更數；若有【建議】逐條列出。
（更多脈絡：查 Supabase handovers 最近幾筆這篇的紀錄。）`;
  try { await navigator.clipboard.writeText(text); toast("已複製「整篇重排版」任務 ✅ 貼到新的 CC session"); }
  catch (e) { console.warn(e); toast("複製失敗（剪貼簿權限）"); }
}

// ── 套用重排（原子三步：先備份、再促升；再驗一次歸零＋零位移）──────────────────
async function applyReformat() {
  const pg = currentPage(); if (!pg) return toast("找不到目前頁面");
  const marks = countTagOnPage(TODO_TAG, pg.uid) + countTagOnPage(PROP_TAG, pg.uid);   // 閘門①：重驗歸零（打包→回來之間可能又標了）
  const draft = countTagOnPage(DRAFT_TAG, pg.uid);
  if (marks || draft) return toast(`還有 ${marks} 標記／${draft} 草稿未清，不能套用`);
  const prop = queryReformatProposal(pg.uid);                                          // 閘門②：提案存在且有【重排結果】
  if (!prop || !prop.resultUid) return toast("找不到重排提案（或缺【重排結果】）");
  const bodyTexts = gatherBodyBlocks(pg.uid);
  const vr = verifyZeroDrift(bodyTexts, prop.proposalTexts);                           // 閘門③：重跑零位移驗證
  if (!vr.ok) return toast("零位移驗證未過，已鎖住套用（請退回提案）");
  const resultKids = ((prop.resultNode && prop.resultNode[":block/children"]) || []).slice().sort((a, b) => (a[":block/order"] || 0) - (b[":block/order"] || 0));
  if (!resultKids.length) return toast("【重排結果】是空的，未套用");
  const topBody = topLevelBodyUids(pg.uid);
  // 收集提案樹裡所有 ##／### 標題 block（含巢狀）→ 促升後轉 Roam heading 屬性、去前綴
  const headingUpdates = [];
  (function collect(n) {
    const hm = (n[":block/string"] || "").match(/^\s*(#{2,3})\s+([\s\S]*)$/);
    if (hm) headingUpdates.push({ uid: n[":block/uid"], heading: hm[1].length, string: hm[2] });
    for (const c of (n[":block/children"] || [])) collect(c);
  })(prop.resultNode);
  if (topBody.length + resultKids.length > 60) toast("套用中…大頁面請稍候");   // 大頁進度提示
  applying = true;
  try {
    // ① 頁底建「🗄 排版前備份 … #cc排版備份」root（collapsed）
    const backupUid = window.roamAlphaAPI.util.generateUID();
    await window.roamAlphaAPI.createBlock({ location: { "parent-uid": pg.uid, order: "last" }, block: { string: `🗄 排版前備份 ${reformatStamp()} #${REFORMAT_BACKUP_TAG}`, uid: backupUid } });
    try { await window.roamAlphaAPI.updateBlock({ block: { uid: backupUid, open: false } }); } catch (e) {}   /* 待 live 驗：updateBlock 的 open 欄位 */
    // ② 現有正文 top-level blocks 依序搬進備份（保序：order 自己遞增指定）
    let bo = 0;
    for (const b of topBody) await window.roamAlphaAPI.moveBlock({ location: { "parent-uid": backupUid, order: bo++ }, block: { uid: b.uid } });   /* 待 live 驗：moveBlock 保序 */
    // ③ 【重排結果】直接子層促升到頁面 top-level（order 0 遞增＝排版後正文置頂）；整棵子樹跟著 move
    let po = 0;
    for (const k of resultKids) await window.roamAlphaAPI.moveBlock({ location: { "parent-uid": pg.uid, order: po++ }, block: { uid: k[":block/uid"] } });   /* 待 live 驗：moveBlock 保序 */
    // ③b ##／### → Roam heading 屬性並去前綴
    for (const h of headingUpdates) await window.roamAlphaAPI.updateBlock({ block: { uid: h.uid, string: h.string, heading: h.heading } });   /* 待 live 驗：updateBlock 的 heading 欄位 */
    // ③c 刪提案 root（其下 摘要/建議/已空的重排結果 一併刪）
    await window.roamAlphaAPI.deleteBlock({ block: { uid: prop.rootUid } });
    toast("已套用重排版（原稿備份在頁底 🗄）");
  } catch (e) {
    console.warn("[請CC修改] applyReformat failed", e);
    toast("套用失敗（見 Console；原稿在備份或原位，可還原）");
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
    const vr = verifyZeroDrift(gatherBodyBlocks(pg.uid), prop.proposalTexts);   // 只在開卡時驗（不每輪跑）
    const summary = (prop.summaryStr || "").replace(/^[\s\S]*?【變更摘要】/, "").trim() || "（無摘要）";
    const suggest = (prop.suggestStr || "").replace(/^[\s\S]*?【建議】/, "").trim();
    let verifyHtml;
    if (vr.ok) verifyHtml = `<div class="ccm-rc-verify ok">零位移驗證：✅ 逐字等值（格式記號守恆）</div>`;
    else {
      let why;
      if (!vr.textOk && vr.firstDiff) why = `內文位移（第 ${vr.firstDiff.pos} 字）<div class="ccm-rc-diff"><span class="old">原稿…${escapeHtml(vr.firstDiff.before)}…</span><span class="new">提案…${escapeHtml(vr.firstDiff.after)}…</span></div>`;
      else if (!vr.counts.ok) why = "格式記號遺失：" + vr.counts.diff.map((d) => `${tokenLabel(d.kind)} 原${d.body}→提案${d.proposal}`).join("、");
      else why = "未通過";
      verifyHtml = `<div class="ccm-rc-verify bad">零位移驗證：❌ ${why}</div>`;
    }
    card.innerHTML =
      `<div class="ccm-rc-head">📐 排版提案 · 待審 ${closeX}</div>` +
      `<div class="ccm-rc-status">變更摘要：${escapeHtml(summary)}</div>` +
      verifyHtml +
      (suggest && suggest !== "無" ? `<div class="ccm-rc-suggest">💡 建議：${escapeHtml(suggest)}</div>` : "") +
      `<div class="ccm-rc-actions"><button class="ccm-rc-compare">👀 對照</button><button class="ccm-rc-apply">✅ 套用（原稿自動備份）</button><button class="ccm-rc-return">↩ 退回</button></div>`;
    card.querySelector(".ccm-rc-compare").onclick = () => openReformatCompare(prop);
    const applyBtn = card.querySelector(".ccm-rc-apply");
    if (!vr.ok) { applyBtn.disabled = true; applyBtn.classList.add("ccm-rc-disabled"); applyBtn.title = "零位移驗證未過，已鎖住（fail-closed）"; }
    applyBtn.onclick = () => { if (vr.ok) applyReformat(); };
    card.querySelector(".ccm-rc-return").onclick = () => returnReformatProposal(prop);
  } else if (st.kind === "C") {   // 已套用：↺ 還原／🧹 清除備份
    card.innerHTML =
      `<div class="ccm-rc-head">📐 已套用重排版 ${closeX}</div>` +
      `<div class="ccm-rc-status">原稿備份在頁底 🗄（可隨時還原）</div>` +
      `<div class="ccm-rc-actions"><button class="ccm-rc-restore">↺ 還原排版前備份</button><button class="ccm-rc-clear">🧹 清除備份</button></div>`;
    card.querySelector(".ccm-rc-restore").onclick = () => restoreReformatBackup();
    card.querySelector(".ccm-rc-clear").onclick = () => clearReformatBackup();
  } else {   // A｜尚無提案：狀態＋歸零閘門＋打包鈕
    const todo = countTagOnPage(TODO_TAG, pg.uid), prop = countTagOnPage(PROP_TAG, pg.uid), draft = countTagOnPage(DRAFT_TAG, pg.uid);
    const published = pageHasPublished(pg.uid);
    const zeroed = todo + prop === 0 && draft === 0;
    let banner;
    if (published) banner = `<div class="ccm-rc-warn">⚠️ 本頁已發佈封存，排版請直接改 Hugo</div>`;
    else if (!zeroed) banner = `<div class="ccm-rc-warn">⚠️ 還有 ${todo + prop} 個標記／${draft} 個草稿，先清完才能重排</div>`;
    else banner = `<div class="ccm-rc-ok">✅ 可重排</div>`;
    card.innerHTML =
      `<div class="ccm-rc-head">📐 整篇重排版 ${closeX}</div>` +
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
  reformatBtn.textContent = has ? "📐 排版提案 ●" : "📐 重排版";
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
  reformatBtn = document.createElement("div"); reformatBtn.className = "ccm-fab-btn ccm-reformat-btn"; reformatBtn.textContent = "📐 重排版";
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
  e.preventDefault(); e.stopPropagation(); curtainDragging = true;
  document.addEventListener("pointermove", curtainDragMove);
  document.addEventListener("pointerup", curtainDragEnd);
}
function buildCurtain() {
  curtainEl = document.createElement("div"); curtainEl.className = "ccm-curtain"; curtainEl.style.display = "none";
  document.body.appendChild(curtainEl);
  // 橫跨寬度的透明拖曳帶，貼在虛線上——整條線都能抓著拉（其餘簾身仍穿透）
  curtainEdge = document.createElement("div"); curtainEdge.className = "ccm-curtain-edge"; curtainEdge.style.display = "none";
  curtainEdge.title = "拖曳這條線＝移動審稿進度";
  curtainEdge.addEventListener("pointerdown", curtainStartDrag);
  document.body.appendChild(curtainEdge);
  curtainGrip = document.createElement("div"); curtainGrip.className = "ccm-curtain-grip"; curtainGrip.style.display = "none";
  curtainGrip.innerHTML =
    '<span class="ccm-cg-op" title="更透明">－</span>' +
    '<span class="ccm-cg-label" title="拖曳＝移動審稿線；數字＝審稿進度（拉到最後一段＝100%）">⬍ 審到這</span>' +
    '<span class="ccm-cg-op" title="更濃">＋</span>' +
    '<span class="ccm-cg-x" title="關閉簾子">✕</span>';
  curtainGrip.querySelector(".ccm-cg-label").addEventListener("pointerdown", curtainStartDrag);
  const ops = curtainGrip.querySelectorAll(".ccm-cg-op");
  ops[0].onclick = (e) => { e.stopPropagation(); setCurtainOpacity(curtainOpacity - 0.06); };
  ops[1].onclick = (e) => { e.stopPropagation(); setCurtainOpacity(curtainOpacity + 0.06); };
  curtainGrip.querySelector(".ccm-cg-x").onclick = (e) => { e.stopPropagation(); setCurtain(false); };
  document.body.appendChild(curtainGrip);
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
  curtainAnchor = (sc.scrollTop || 0) + (yv - baseTop);
  positionCurtain();
}
function curtainDragEnd() {
  if (!curtainDragging) return;
  curtainDragging = false;
  document.removeEventListener("pointermove", curtainDragMove);
  document.removeEventListener("pointerup", curtainDragEnd);
  try { api.settings.set("curtainAnchor", Math.round(curtainAnchor)); } catch (e) {}
  // 把「審到這條線」錨定到某個 block（穩定、跨螢幕/跨電腦），依「本頁」分開記
  const pg = currentOpenUid();
  if (pg) { const u = curtainAnchorBlockUid(); if (u) { curtainByPage[pg] = u; saveCurtainPages(); } }
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
  .ccm-mark-hidden{display:none !important;}
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
  .ccm-curtain-grip .ccm-cg-op,.ccm-curtain-grip .ccm-cg-x{cursor:pointer;width:17px;height:17px;line-height:17px;text-align:center;border-radius:5px;background:rgba(255,255,255,.16);font-size:12px;}
  .ccm-curtain-grip .ccm-cg-op:hover,.ccm-curtain-grip .ccm-cg-x:hover{background:rgba(255,255,255,.32);}
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
    { label: "請CC修改：重整標記", callback: () => refreshDecorations(true) },
  ];
  cmds.forEach((c) => window.roamAlphaAPI.ui.commandPalette.addCommand(c));
  setTimeout(() => refreshDecorations(true), 400);
  console.log("[請CC修改] v3 loaded — 導覽列 ✅接受/↩退回 鈕 + 泡泡 max-height");
  setTimeout(() => toast("請CC修改 v3 已載入：導覽列多了 ✅接受 / ↩退回"), 600);   // 載入確認：看到這則＝新碼真的上了
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
  if (curtainDragging) { document.removeEventListener("pointermove", curtainDragMove); document.removeEventListener("pointerup", curtainDragEnd); }
  [styleEl, overlayEl, panelEl, pillEl, triggerBtn, fabRow, navEl, curtainEl, curtainGrip, curtainEdge, reformatCard].forEach((e) => e && e.remove());
  const labels = ["請CC修改：開關標記模式", "請CC修改：標記游標處 (⌥M)", "請CC修改：在游標 block 後插入新段 (⌥N)", "請CC修改：下一個 (⌥↓)", "請CC修改：上一個 (⌥↑)", "請CC修改：打包本頁待處理給 CC", "請CC修改：打包『轉 Hugo 成稿』給 CC", "請CC修改：打包『整篇重排版』給 CC", "請CC修改：套用排版提案", "請CC修改：還原排版前備份", "請CC修改：審稿簾 開/關", "請CC修改：重整標記"];
  try { labels.forEach((l) => window.roamAlphaAPI.ui.commandPalette.removeCommand({ label: l })); } catch (e) {}
  console.log("[請CC修改] unloaded");
}

export default { onload, onunload };
