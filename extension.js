// ────────────────────────────────────────────────────────────────
// 原稿改稿助手 (請CC修改)  ·  Roam developer extension
//
// 右下角開關：關 = 完全不動作（不干擾你的選字/其他 toolbar）
//            開 = 框選 block 內文字 → (小按鈕/自動) 輸入框 → 送出後
//                 在該 block 底下建 #請cc修改 【指令】… 【原文】「…」 子 block
//
// 鍵盤流（隨時可用，不必開開關）：
//   ⌥M  框選/游標在段內 → 開輸入框（沒選取 = 整段標記）
//   面板內 ⌥1–6 = 套常用指令並直接送出
//   ⌥↓ / ⌥↑ = 跳下一個 / 上一個標記
//   點底線文字 或 hover 泡泡「編輯/刪除」 = 修改 / 刪除
//   待改膠囊 → ▲▼ 導覽 + 📋 一鍵打包本頁標記給 CC
//
// 真相來源 = Roam 的子 block；畫面（底線＋泡泡）每次從 graph 重讀重畫。
// 同段文字重複時自動加【第N處】錨點，CC 不會改錯位置。
// ────────────────────────────────────────────────────────────────

const DEFAULTS = { tagName: "請cc修改", bubbleMode: "hover", triggerMode: "auto" };
let api;                       // extensionAPI
let styleEl, overlayEl, panelEl, pillEl, triggerBtn, toggleBtn, navEl;
let observer, debounceTimer, applying = false, active = false, navIdx = -1;
let alwaysBubbles = [];
let pending = null;            // create: {mode,marks:[{parentUid,quote,occurrence}],label} | edit: {mode,childUid,quote,occurrence}
let scrollBound = null, keyBound = null;

const cfg = (k) => {
  const v = api?.settings?.get(k);
  return (v === undefined || v === null || v === "") ? DEFAULTS[k] : v;
};

// ── util ──────────────────────────────────────────────────────
function tagPageTitle() { return cfg("tagName"); }

function uidFromId(el) {
  if (el && el.id) {
    const m = el.id.match(/([A-Za-z0-9_\-]{9})$/);
    if (m) return m[1];
  }
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

// 某段文字裡，從 startOffset 開始的那個 needle 是第幾個出現（1-based）；只有出現 >1 次才算數
function occurrenceOf(fullText, needle, startOffset) {
  if (!needle) return 1;
  let total = 0, idx = 0;
  while (true) { const i = fullText.indexOf(needle, idx); if (i === -1) break; total++; idx = i + needle.length; }
  if (total <= 1) return 1;
  let before = 0; idx = 0;
  while (true) { const i = fullText.indexOf(needle, idx); if (i === -1 || i >= startOffset) break; before++; idx = i + needle.length; }
  return before + 1;
}

// 選取起點在 container 內的字元位移
function offsetInContainer(container, node, nodeOffset) {
  let offset = 0;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  let n;
  while ((n = walker.nextNode())) {
    if (n === node) return offset + nodeOffset;
    offset += n.nodeValue.length;
  }
  return 0;
}

// 從子 block 字串抽出 指令 / 第N處 / 原文
function parseMark(s) {
  const insMatch = s.match(/【指令】([\s\S]*?)(?:【第\d+處】|【原文】|$)/);
  const occMatch = s.match(/【第(\d+)處】/);
  const quoteMatch = s.match(/【原文】\s*「([\s\S]*?)」\s*$/);
  return {
    instruction: insMatch ? insMatch[1].trim() : s.replace(/#\S+/, "").trim(),
    quote: quoteMatch ? quoteMatch[1] : "",
    occurrence: occMatch ? parseInt(occMatch[1], 10) : 1,
  };
}

// 全 graph 標記（child uid / parent uid / 字串）— 給畫面用
function queryMarks() {
  const title = tagPageTitle();
  try {
    const q = `[:find ?cu ?pu ?s ?pageuid
      :where [?t :node/title "${title}"]
        [?c :block/refs ?t] [?c :block/uid ?cu] [?c :block/string ?s]
        [?p :block/children ?c] [?p :block/uid ?pu]
        [?p :block/page ?pg] [?pg :block/uid ?pageuid]]`;
    return window.roamAlphaAPI.q(q) || [];
  } catch (e) { console.warn("[請CC修改] queryMarks failed", e); return []; }
}

function findBlockTextEl(uid) {
  const els = document.querySelectorAll('.rm-block-text, .roam-block');
  for (const el of els) if (el.id && el.id.endsWith(uid)) return el;
  for (const el of els) if (el.id && el.id.indexOf(uid) !== -1) return el;
  return document.querySelector('[id^="block-input"][id$="' + uid + '"]');
}

// ── 畫底線 + 泡泡 ────────────────────────────────────────────
function wrapNeedle(container, needle, childUid, instruction, occurrence) {
  if (!needle) return false;
  occurrence = occurrence || 1;
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
        range.setStart(n, idx);
        range.setEnd(n, idx + needle.length);
        const span = document.createElement("span");
        span.className = "ccm-underline";
        span.dataset.child = childUid;
        span.dataset.ins = instruction || "";
        span.dataset.quote = needle;
        span.dataset.occ = String(occurrence);
        try { range.surroundContents(span); } catch (e) { return false; }
        span.addEventListener("click", (e) => { e.stopPropagation(); openEditData(childUid, instruction || "", needle, span, occurrence); });
        attachBubble(span, instruction, childUid, needle, occurrence);
        return true;
      }
      from = idx + needle.length;
    }
  }
  return false;
}

function attachBubble(anchorEl, instruction, childUid, quote, occurrence) {
  const mode = cfg("bubbleMode");
  const makeBubble = () => {
    const b = document.createElement("div");
    b.className = "ccm-bubble";
    b.innerHTML =
      '<div class="ccm-lbl">請CC修改</div>' +
      '<div class="ccm-ins"></div>' +
      '<div class="ccm-bactions"><button class="ccm-bedit">編輯</button><button class="ccm-bdel">刪除</button></div>';
    b.querySelector(".ccm-ins").textContent = instruction || "(無指令)";
    b.querySelector(".ccm-bedit").onclick = (e) => { e.stopPropagation(); openEditData(childUid, instruction || "", quote, anchorEl, occurrence); };
    b.querySelector(".ccm-bdel").onclick = (e) => { e.stopPropagation(); deleteMark(childUid); };
    overlayEl.appendChild(b);
    positionBubble(b, anchorEl);
    return b;
  };

  if (mode === "always") {
    const b = makeBubble();
    alwaysBubbles.push({ b, anchorEl });
    return;
  }
  let b = null, hideT = null;
  const cancelHide = () => { if (hideT) { clearTimeout(hideT); hideT = null; } };
  const scheduleHide = () => { cancelHide(); hideT = setTimeout(() => { if (b) { b.remove(); b = null; } }, 450); };
  const show = () => { cancelHide(); if (!b) { b = makeBubble(); b.addEventListener("mouseenter", cancelHide); b.addEventListener("mouseleave", scheduleHide); } };
  anchorEl.addEventListener("mouseenter", show);
  anchorEl.addEventListener("mouseleave", scheduleHide);
}

function positionBubble(b, anchorEl) {
  const r = anchorEl.getBoundingClientRect();
  b.style.left = (r.left + window.scrollX + r.width / 2) + "px";
  b.style.top = (r.top + window.scrollY - 6) + "px";
}
function repositionAlways() {
  alwaysBubbles.forEach(({ b, anchorEl }) => { if (document.body.contains(anchorEl)) positionBubble(b, anchorEl); });
}

// ── refresh：內容沒變就不重畫 ───────────────────────────────
function clearDecorations() {
  document.querySelectorAll(".ccm-underline").forEach((s) => {
    const p = s.parentNode;
    if (!p) return;
    while (s.firstChild) p.insertBefore(s.firstChild, s);
    p.removeChild(s); p.normalize();
  });
  document.querySelectorAll(".ccm-block-flag").forEach((e) => e.classList.remove("ccm-block-flag"));
  overlayEl.innerHTML = "";
  alwaysBubbles = [];
}

function refreshDecorations(force) {
  if (!overlayEl) return;
  const rows = queryMarks();
  const curPage = currentPage();
  const pageUid = curPage && curPage.uid;
  const pageCount = pageUid ? rows.filter((r) => r[3] === pageUid).length : 0;
  const desired = [];
  for (const [cu, pu, s] of rows) { const el = findBlockTextEl(pu); if (el) desired.push({ cu, s, el }); }
  const current = new Set();
  document.querySelectorAll(".ccm-underline").forEach((e) => current.add(e.dataset.child));
  document.querySelectorAll(".ccm-block-flag").forEach((e) => current.add(e.dataset.ccmChild));
  const same = desired.length === current.size && desired.every((d) => current.has(d.cu));
  if (!force && same) { updatePill(pageCount); return; }

  applying = true;
  clearDecorations();
  for (const { cu, s, el } of desired) {
    const { instruction, quote, occurrence } = parseMark(s);
    const ok = quote && wrapNeedle(el, quote, cu, instruction, occurrence);
    if (!ok) { el.classList.add("ccm-block-flag"); el.dataset.ccmChild = cu; }
  }
  updatePill(pageCount);
  setTimeout(() => { applying = false; }, 0);
}
const debouncedRefresh = () => { clearTimeout(debounceTimer); debounceTimer = setTimeout(refreshDecorations, 250); };

// ── 新增 / 修改 / 刪除標記 ──────────────────────────────────
function markString(instruction, quote, occurrence) {
  let s = `#${tagPageTitle()} 【指令】${instruction}`;
  if (quote) {
    if (occurrence && occurrence > 1) s += ` 【第${occurrence}處】`;
    s += ` 【原文】「${quote}」`;
  }
  return s;
}
async function createMark(parentUid, quote, instruction, occurrence) {
  const uid = window.roamAlphaAPI.util.generateUID();
  await window.roamAlphaAPI.createBlock({
    location: { "parent-uid": parentUid, order: "last" },
    block: { string: markString(instruction, quote, occurrence), uid },
  });
  setTimeout(() => refreshDecorations(true), 120);
}
async function updateMark(childUid, instruction, quote, occurrence) {
  try { await window.roamAlphaAPI.updateBlock({ block: { uid: childUid, string: markString(instruction, quote, occurrence) } }); }
  catch (e) { console.warn("[請CC修改] update failed", e); }
  setTimeout(() => refreshDecorations(true), 120);
}
async function deleteMark(childUid) {
  try { await window.roamAlphaAPI.deleteBlock({ block: { uid: childUid } }); }
  catch (e) { console.warn("[請CC修改] delete failed", e); }
  setTimeout(() => refreshDecorations(true), 120);
}

// ── 擷取選取 → 產生要建立的標記清單 ─────────────────────────
// allowWholeBlock: 只有鍵盤 ⌥M 才允許「沒選取 = 整段標記」（滑鼠點擊不觸發）
function captureSelection(allowWholeBlock) {
  const ae = document.activeElement;
  // Case 1：編輯中的 block 是 textarea
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
  // Case 2：rendered 選取
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) {
    const t = sel.toString().trim();
    if (!t) return null;
    const range = sel.getRangeAt(0);
    const startUid = getUidFromNode(range.startContainer);
    const startEl = range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer.parentElement : range.startContainer;
    if (!startUid || !startEl || !startEl.closest('.roam-block, .rm-block-text, [id^="block-input"]')) return null;
    // 跨 block？
    const blocks = Array.from(document.querySelectorAll('.rm-block-text, .roam-block'))
      .filter((el) => { try { return sel.containsNode(el, true); } catch (e) { return false; } });
    const uids = [];
    for (const el of blocks) { const u = uidFromId(el); if (u && !uids.includes(u)) uids.push(u); }
    if (uids.length > 1) {
      return { marks: uids.map((u) => ({ parentUid: u, quote: "", occurrence: 1 })), label: uids.length + " 個段落（整段）" };
    }
    const container = findBlockTextEl(startUid) || startEl;
    const off = offsetInContainer(container, range.startContainer, range.startOffset);
    const occ = occurrenceOf(container.textContent || "", t, off);
    return { marks: [{ parentUid: startUid, quote: t, occurrence: occ }], label: "「" + t + "」" };
  }
  return null;
}

// 開輸入框（滑鼠 or 鍵盤共用）
function markFromSelection(x, y, viaKeyboard) {
  const cap = captureSelection(viaKeyboard);
  if (!cap) { hidePanel(); hideTrigger(); return false; }
  pending = { mode: "create", marks: cap.marks, label: cap.label };
  if (viaKeyboard || cfg("triggerMode") === "auto") { hideTrigger(); showPanel(x, y, cap.label, ""); }
  else showTrigger(x, y);
  return true;
}

function onMouseUp(e) {
  if (e.target && e.target.closest && e.target.closest(".ccm-bubble")) return;
  if (!active) return;
  if (panelEl && panelEl.contains(e.target)) return;
  if (triggerBtn && triggerBtn.contains(e.target)) return;
  setTimeout(() => markFromSelection(e.pageX, e.pageY, false), 10);
}

function keyboardAnchorXY() {
  const sel = window.getSelection();
  if (sel && sel.rangeCount && !sel.isCollapsed) {
    const r = sel.getRangeAt(0).getBoundingClientRect();
    if (r.width || r.height) return { x: r.left + window.scrollX + r.width / 2, y: r.bottom + window.scrollY };
  }
  const ae = document.activeElement;
  if (ae && ae.getBoundingClientRect) {
    const r = ae.getBoundingClientRect();
    return { x: r.left + window.scrollX + Math.min(r.width / 2, 220), y: r.top + window.scrollY + 22 };
  }
  return { x: window.scrollX + window.innerWidth / 2, y: window.scrollY + 200 };
}

function onKeyDown(e) {
  // ⌥M → 標記（沒選取＝整段）
  if (e.altKey && e.code === "KeyM" && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    const { x, y } = keyboardAnchorXY();
    markFromSelection(x, y, true);
    return;
  }
  // ⌥↓ / ⌥↑ → 導覽
  if (e.altKey && (e.code === "ArrowDown" || e.code === "ArrowUp") && !e.ctrlKey && !e.metaKey) {
    if (!document.querySelector(".ccm-underline, .ccm-block-flag")) return;
    e.preventDefault();
    if (navEl && navEl.style.display === "none") { navEl.style.display = "flex"; navIdx = -1; }
    navGo(e.code === "ArrowDown" ? 1 : -1);
  }
}

// 點底線文字 / 泡泡「編輯」→ 開編輯面板
function openEditData(childUid, ins, quote, anchorEl, occurrence) {
  pending = { mode: "edit", childUid, quote, occurrence: occurrence || 1 };
  const r = anchorEl.getBoundingClientRect();
  showPanel(r.left + window.scrollX + r.width / 2, r.bottom + window.scrollY, "「" + quote + "」", ins);
}

function showTrigger(x, y) { triggerBtn.style.display = "block"; triggerBtn.style.left = x + "px"; triggerBtn.style.top = (y + 10) + "px"; }
function hideTrigger() { if (triggerBtn) triggerBtn.style.display = "none"; }

function showPanel(x, y, label, prefill) {
  const isEdit = pending && pending.mode === "edit";
  panelEl.querySelector(".ccm-head").textContent = isEdit ? "✏️ 修改 / 刪除標記" : "✏️ 請CC修改";
  panelEl.querySelector(".ccm-picked").textContent = label;
  panelEl.querySelector(".ccm-delete").style.display = isEdit ? "inline-block" : "none";
  const ta = panelEl.querySelector("textarea");
  ta.value = prefill || "";
  panelEl.style.display = "block";
  panelEl.style.left = x + "px";
  panelEl.style.top = (y + 12) + "px";
  setTimeout(() => { ta.focus(); ta.select(); }, 0);
}
function hidePanel() { if (panelEl) panelEl.style.display = "none"; pending = null; }

async function submitPanel() {
  const ta = panelEl.querySelector("textarea");
  const ins = ta.value.trim();
  if (!ins || !pending) return hidePanel();
  const p = pending;
  try { window.getSelection().removeAllRanges(); } catch (e) {}
  hidePanel();
  if (p.mode === "edit") await updateMark(p.childUid, ins, p.quote, p.occurrence);
  else for (const m of p.marks) await createMark(m.parentUid, m.quote, ins, m.occurrence);
}

// ── 打包本頁標記給 CC ───────────────────────────────────────
function currentPage() {
  try {
    const uid = window.roamAlphaAPI.ui.mainWindow.getOpenPageOrBlockUid();
    if (!uid) return null;
    const p = window.roamAlphaAPI.pull("[:node/title :block/uid {:block/page [:node/title :block/uid]}]", [":block/uid", uid]);
    if (p && p[":node/title"]) return { uid, title: p[":node/title"] };
    if (p && p[":block/page"]) return { uid: p[":block/page"][":block/uid"], title: p[":block/page"][":node/title"] };
    return { uid, title: "(目前頁)" };
  } catch (e) { return null; }
}
function queryPageMarks(pageUid) {
  const title = tagPageTitle();
  try {
    const q = `[:find ?cu ?cs ?pu ?ps
      :where [?t :node/title "${title}"]
        [?c :block/refs ?t] [?c :block/uid ?cu] [?c :block/string ?cs]
        [?p :block/children ?c] [?p :block/uid ?pu] [?p :block/string ?ps]
        [?p :block/page ?pg] [?pg :block/uid "${pageUid}"]]`;
    return window.roamAlphaAPI.q(q) || [];
  } catch (e) { console.warn(e); return []; }
}
async function copyMarksPrompt() {
  const pg = currentPage();
  if (!pg) return toast("找不到目前頁面");
  const rows = queryPageMarks(pg.uid);
  if (!rows.length) return toast("本頁沒有標記");
  const lines = rows.map(([cu, cs, pu, ps], i) => {
    const { instruction, quote, occurrence } = parseMark(cs);
    const where = quote ? `原文第 ${occurrence} 處「${quote}」` : "整段";
    return `${i + 1}. [block ${pu}] 指令：${instruction}｜${where}\n   目前內容：${ps}`;
  });
  const text =
    `請改 Roam page「${pg.title}」的原稿（page uid: ${pg.uid}）。\n` +
    `先完整讀這一頁掌握上下文，再逐處依指令修改——改的時候要參考前後文、保持語氣連貫與原意，不要孤立改單句；改完把該標記子 block 刪掉。全部標記清空＝定稿。\n\n` +
    `共 ${rows.length} 處：\n` + lines.join("\n");
  try { await navigator.clipboard.writeText(text); toast(`已複製本頁 ${rows.length} 個標記給 CC`); }
  catch (e) { console.warn(e); toast("複製失敗（剪貼簿權限）"); }
}
function toast(msg) {
  const t = document.createElement("div");
  t.className = "ccm-toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; }, 1700);
  setTimeout(() => { t.remove(); }, 2200);
}

// ── build UI ─────────────────────────────────────────────────
function buildUI() {
  overlayEl = document.createElement("div");
  overlayEl.className = "ccm-overlay";
  document.body.appendChild(overlayEl);

  triggerBtn = document.createElement("div");
  triggerBtn.className = "ccm-trigger";
  triggerBtn.textContent = "✏️ 請CC修改";
  triggerBtn.style.display = "none";
  triggerBtn.addEventListener("mousedown", (e) => e.preventDefault());
  triggerBtn.addEventListener("click", () => {
    if (!pending) return hideTrigger();
    const r = triggerBtn.getBoundingClientRect();
    hideTrigger();
    showPanel(r.left + window.scrollX, r.top + window.scrollY, pending.label || "", "");
  });
  document.body.appendChild(triggerBtn);

  panelEl = document.createElement("div");
  panelEl.className = "ccm-panel";
  panelEl.innerHTML =
    '<div class="ccm-head">✏️ 請CC修改</div>' +
    '<div class="ccm-picked"></div>' +
    '<textarea placeholder="要 CC 怎麼改…（Enter 送出，⌥1–6 套指令直接送）"></textarea>' +
    '<div class="ccm-chips">' +
      '<span>口語化</span><span>縮短</span><span>去 AI 腔</span>' +
      '<span>補來源</span><span>改台灣用語</span><span>查證數字</span>' +
    '</div>' +
    '<div class="ccm-actions">' +
      '<button class="ccm-delete">刪除</button>' +
      '<button class="ccm-cancel">取消</button>' +
      '<button class="ccm-save">送出</button>' +
    '</div>';
  document.body.appendChild(panelEl);
  panelEl.style.display = "none";

  panelEl.querySelector(".ccm-chips").addEventListener("click", (e) => {
    if (e.target.tagName === "SPAN") {
      const ta = panelEl.querySelector("textarea");
      ta.value = (ta.value ? ta.value + "、" : "") + e.target.textContent;
      ta.focus();
    }
  });
  panelEl.querySelector(".ccm-cancel").onclick = hidePanel;
  panelEl.querySelector(".ccm-save").onclick = submitPanel;
  panelEl.querySelector(".ccm-delete").onclick = () => {
    if (pending && pending.mode === "edit") { const uid = pending.childUid; hidePanel(); deleteMark(uid); }
    else hidePanel();
  };
  panelEl.querySelector("textarea").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitPanel(); return; }
    if (e.key === "Escape") { hidePanel(); return; }
    if (e.altKey && /^Digit[1-6]$/.test(e.code)) {
      e.preventDefault();
      const idx = parseInt(e.code.slice(5), 10) - 1;
      const chips = Array.from(panelEl.querySelectorAll(".ccm-chips span"));
      if (chips[idx]) { e.target.value = chips[idx].textContent; submitPanel(); }
    }
  });

  pillEl = document.createElement("div");
  pillEl.className = "ccm-pill";
  pillEl.style.display = "none";
  pillEl.onclick = () => toggleNav();
  document.body.appendChild(pillEl);

  navEl = document.createElement("div");
  navEl.className = "ccm-nav";
  navEl.style.display = "none";
  navEl.innerHTML =
    '<button class="ccm-nav-prev" title="上一個 (⌥↑)">▲</button>' +
    '<span class="ccm-nav-label">–</span>' +
    '<button class="ccm-nav-next" title="下一個 (⌥↓)">▼</button>' +
    '<button class="ccm-nav-copy" title="打包本頁標記給 CC">📋</button>';
  navEl.querySelector(".ccm-nav-prev").onclick = () => navGo(-1);
  navEl.querySelector(".ccm-nav-next").onclick = () => navGo(1);
  navEl.querySelector(".ccm-nav-copy").onclick = () => copyMarksPrompt();
  document.body.appendChild(navEl);

  toggleBtn = document.createElement("div");
  toggleBtn.className = "ccm-toggle";
  toggleBtn.title = "開 / 關「請CC修改」標記模式（⌥M 隨時可標）";
  toggleBtn.onclick = () => setActive(!active);
  document.body.appendChild(toggleBtn);
  updateToggle();
}

function updatePill(count) {
  if (!pillEl) return;
  if (!count) { pillEl.style.display = "none"; if (navEl) navEl.style.display = "none"; return; }
  pillEl.style.display = "block";
  pillEl.innerHTML = `📝 本頁待改 <b>${count}</b>`;
}

// ── 上下導覽 ─────────────────────────────────────────────────
function navMarks() {
  const els = Array.from(document.querySelectorAll(".ccm-underline, .ccm-block-flag"));
  els.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  return els;
}
function navGo(dir) {
  const els = navMarks();
  if (!els.length) { updateNavLabel(0); return; }
  navIdx = (navIdx + dir + els.length) % els.length;
  const el = els[navIdx];
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  const prev = el.style.background;
  el.style.background = "#ffd54a";
  setTimeout(() => { el.style.background = prev; }, 900);
  updateNavLabel(els.length);
}
function updateNavLabel(total) {
  const lbl = navEl && navEl.querySelector(".ccm-nav-label");
  if (lbl) lbl.textContent = total ? (navIdx + 1) + "/" + total : "0";
}
function toggleNav() {
  if (!navEl) return;
  if (navEl.style.display !== "none") { navEl.style.display = "none"; return; }
  navEl.style.display = "flex";
  navIdx = -1;
  navGo(1);
}

// ── 開關 ─────────────────────────────────────────────────────
function setActive(v) {
  active = v;
  try { api.settings.set("active", v); } catch (e) {}
  updateToggle();
  if (!v) { hidePanel(); hideTrigger(); }
}
function updateToggle() {
  if (!toggleBtn) return;
  toggleBtn.textContent = active ? "✏️ 標記模式：開" : "✏️ 標記模式：關";
  toggleBtn.classList.toggle("on", active);
}

// ── style ────────────────────────────────────────────────────
function injectStyle() {
  styleEl = document.createElement("style");
  styleEl.textContent = `
  .ccm-underline{background:#fff2c9;border-bottom:2px solid #f0a020;border-radius:2px;padding:0 1px;cursor:pointer;transition:background .12s;}
  .ccm-underline:hover{background:#ffe79a;}
  .ccm-block-flag{box-shadow:-3px 0 0 #f0a020;background:#fffaf0;cursor:pointer;}
  .ccm-overlay{position:absolute;top:0;left:0;width:0;height:0;z-index:9990;pointer-events:none;}
  .ccm-bubble{position:absolute;width:max-content;max-width:260px;background:#fff;border:1px solid #f0c453;border-radius:9px;
    box-shadow:0 6px 20px rgba(16,22,26,.18);padding:7px 11px 8px;font-size:12.5px;line-height:1.5;color:#33404d;
    transform:translate(-50%,-100%);pointer-events:auto;z-index:9991;}
  .ccm-bubble .ccm-lbl{white-space:nowrap;font-size:10.5px;font-weight:800;color:#b5820c;margin-bottom:2px;}
  .ccm-bubble .ccm-ins{font-weight:600;white-space:normal;}
  .ccm-bubble::after{content:"";position:absolute;left:50%;bottom:-7px;transform:translateX(-50%);
    border:7px solid transparent;border-top-color:#fff;filter:drop-shadow(0 1px 0 #f0c453);}
  .ccm-bubble .ccm-bactions{display:flex;gap:6px;margin-top:7px;}
  .ccm-bubble .ccm-bactions button{font-size:11px;cursor:pointer;border-radius:6px;padding:3px 11px;border:1px solid transparent;font-weight:700;}
  .ccm-bubble .ccm-bedit{background:#2b7de0;color:#fff;}
  .ccm-bubble .ccm-bedit:hover{background:#1e6fd0;}
  .ccm-bubble .ccm-bdel{background:#fff;color:#e5484d;border:1px solid #f3c0c2;}
  .ccm-bubble .ccm-bdel:hover{background:#fdecec;}
  .ccm-trigger{position:absolute;z-index:9996;background:#2b7de0;color:#fff;font-size:12px;font-weight:700;
    padding:4px 10px;border-radius:999px;box-shadow:0 4px 14px rgba(16,22,26,.22);cursor:pointer;
    user-select:none;white-space:nowrap;transform:translateX(-50%);}
  .ccm-trigger:hover{background:#1e6fd0;}
  .ccm-panel{position:absolute;z-index:9995;width:290px;background:#fff;border:1px solid #d5dbe2;border-radius:11px;
    box-shadow:0 10px 30px rgba(16,22,26,.22);padding:11px 12px 12px;transform:translateX(-50%);}
  .ccm-panel .ccm-head{font-size:12px;font-weight:800;color:#2b7de0;margin-bottom:7px;}
  .ccm-panel .ccm-picked{font-size:11.5px;color:#8a94a0;background:#f4f6f8;border-radius:6px;padding:4px 7px;margin-bottom:8px;max-height:42px;overflow:hidden;}
  .ccm-panel textarea{width:100%;min-height:52px;resize:vertical;border:1px solid #d5dbe2;border-radius:7px;padding:7px 8px;font-size:13px;font-family:inherit;line-height:1.5;outline:none;box-sizing:border-box;}
  .ccm-panel textarea:focus{border-color:#2b7de0;box-shadow:0 0 0 3px rgba(43,125,224,.12);}
  .ccm-chips{display:flex;flex-wrap:wrap;gap:5px;margin:8px 0;}
  .ccm-chips span{font-size:11.5px;cursor:pointer;border:1px solid #dbe1e8;background:#f7f9fb;border-radius:999px;padding:3px 9px;color:#4a5560;}
  .ccm-chips span:hover{background:#2b7de0;color:#fff;border-color:#2b7de0;}
  .ccm-actions{display:flex;gap:7px;margin-top:4px;align-items:center;}
  .ccm-actions button{font-size:12.5px;cursor:pointer;border-radius:7px;padding:5px 12px;border:1px solid transparent;}
  .ccm-delete{margin-right:auto;background:#fff;color:#e5484d;border:1px solid #f3c0c2 !important;}
  .ccm-delete:hover{background:#fdecec;}
  .ccm-cancel{background:#f0f2f5;color:#58636e;}
  .ccm-save{background:#2b7de0;color:#fff;font-weight:700;}
  .ccm-save:hover{background:#1e6fd0;}
  .ccm-pill{position:fixed;right:18px;bottom:58px;z-index:9994;background:#fff;border:1px solid #f6d67a;color:#92660b;
    font-size:12.5px;padding:6px 13px;border-radius:999px;box-shadow:0 4px 14px rgba(16,22,26,.14);cursor:pointer;}
  .ccm-pill b{color:#c47f0a;}
  .ccm-nav{position:fixed;right:18px;bottom:98px;z-index:9994;display:flex;align-items:center;gap:6px;
    background:#fff;border:1px solid #d5dbe2;border-radius:999px;padding:4px 8px;box-shadow:0 4px 14px rgba(16,22,26,.16);}
  .ccm-nav button{width:26px;height:26px;border:none;border-radius:50%;background:#eef2f6;color:#37424d;cursor:pointer;font-size:12px;line-height:1;}
  .ccm-nav button:hover{background:#2b7de0;color:#fff;}
  .ccm-nav-label{font-size:12px;font-weight:700;color:#58636e;min-width:34px;text-align:center;}
  .ccm-toggle{position:fixed;right:18px;bottom:18px;z-index:9994;background:#e9edf1;border:1px solid #d5dbe2;color:#58636e;
    font-size:12.5px;font-weight:700;padding:6px 13px;border-radius:999px;box-shadow:0 4px 14px rgba(16,22,26,.14);
    cursor:pointer;user-select:none;transition:background .12s;}
  .ccm-toggle.on{background:#2b7de0;border-color:#2b7de0;color:#fff;box-shadow:0 4px 16px rgba(43,125,224,.35);}
  .ccm-toast{position:fixed;left:50%;bottom:46px;transform:translateX(-50%);z-index:9998;background:#1f2937;color:#fff;
    font-size:12.5px;font-weight:600;padding:8px 16px;border-radius:999px;box-shadow:0 6px 20px rgba(16,22,26,.3);
    opacity:1;transition:opacity .4s;pointer-events:none;}
  `;
  document.head.appendChild(styleEl);
}

// ── observer ─────────────────────────────────────────────────
function startObserver() {
  const root = document.querySelector(".roam-app") || document.body;
  observer = new MutationObserver(() => { if (applying) return; debouncedRefresh(); });
  observer.observe(root, { childList: true, subtree: true, characterData: true });
  scrollBound = () => { debouncedRefresh(); repositionAlways(); };
  window.addEventListener("scroll", scrollBound, true);
  window.addEventListener("resize", scrollBound);
}

// ── lifecycle ────────────────────────────────────────────────
function onload({ extensionAPI }) {
  api = extensionAPI;
  api.settings.panel.create({
    tabTitle: "請CC修改標記",
    settings: [
      { id: "triggerMode", name: "觸發方式",
        description: "auto = 框選直接跳輸入框；button = 框選先跳小按鈕（⌥M 一律直接開框）",
        action: { type: "select", items: ["auto", "button"], onChange: () => {} } },
      { id: "bubbleMode", name: "泡泡框顯示",
        description: "hover = 滑過才出；always = 常駐顯示",
        action: { type: "select", items: ["hover", "always"], onChange: () => setTimeout(() => refreshDecorations(true), 50) } },
      { id: "tagName", name: "標記 tag",
        description: "CC 讀取用的 tag（預設 請cc修改）",
        action: { type: "input", placeholder: "請cc修改", onChange: () => setTimeout(() => refreshDecorations(true), 50) } },
    ],
  });

  injectStyle();
  buildUI();
  active = api.settings.get("active") === true;
  updateToggle();
  document.addEventListener("mouseup", onMouseUp);
  keyBound = onKeyDown;
  document.addEventListener("keydown", keyBound, true);
  startObserver();
  const cmds = [
    { label: "請CC修改：開關標記模式", callback: () => setActive(!active) },
    { label: "請CC修改：標記游標處 (⌥M)", callback: () => { const p = keyboardAnchorXY(); markFromSelection(p.x, p.y, true); } },
    { label: "請CC修改：下一個標記 (⌥↓)", callback: () => navGo(1) },
    { label: "請CC修改：上一個標記 (⌥↑)", callback: () => navGo(-1) },
    { label: "請CC修改：打包本頁標記給 CC", callback: () => copyMarksPrompt() },
    { label: "請CC修改：重整標記", callback: () => refreshDecorations(true) },
  ];
  cmds.forEach((c) => window.roamAlphaAPI.ui.commandPalette.addCommand(c));
  setTimeout(() => refreshDecorations(true), 400);
  console.log("[請CC修改] loaded");
}

function onunload() {
  document.removeEventListener("mouseup", onMouseUp);
  if (keyBound) document.removeEventListener("keydown", keyBound, true);
  if (observer) observer.disconnect();
  if (scrollBound) {
    window.removeEventListener("scroll", scrollBound, true);
    window.removeEventListener("resize", scrollBound);
  }
  clearDecorations();
  [styleEl, overlayEl, panelEl, pillEl, triggerBtn, toggleBtn, navEl].forEach((e) => e && e.remove());
  const labels = ["請CC修改：開關標記模式", "請CC修改：標記游標處 (⌥M)", "請CC修改：下一個標記 (⌥↓)",
    "請CC修改：上一個標記 (⌥↑)", "請CC修改：打包本頁標記給 CC", "請CC修改：重整標記"];
  try { labels.forEach((l) => window.roamAlphaAPI.ui.commandPalette.removeCommand({ label: l })); } catch (e) {}
  console.log("[請CC修改] unloaded");
}

export default { onload, onunload };
