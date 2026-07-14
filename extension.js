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
const INTENTS = ["潤", "接", "查", "議"];
const INTENT_HINT = { "潤": "改這句（口語化/縮短/去AI腔…）", "接": "幫我起一段草稿", "查": "查證/補來源，不改字", "議": "給我選項/建議" };

let api;
let styleEl, overlayEl, panelEl, pillEl, triggerBtn, toggleBtn, navEl;
let observer, debounceTimer, applying = false, active = false, navIdx = -1;
let pending = null;            // create:{mode,marks:[{parentUid,quote,occurrence}],label} | edit:{mode,childUid,quote,occurrence}
let panelIntent = "潤";
let scrollBound = null, keyBound = null;

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
  const insMatch = s.match(/【指令】([\s\S]*?)(?:【第\d+處】|【原文】|【提案】|【備註】|$)/);
  let intent = "潤", detail = "";
  if (insMatch) {
    const raw = insMatch[1].trim();
    const im = raw.match(/^(潤|接|查|議)\s*[:：]?\s*([\s\S]*)$/);
    if (im) { intent = im[1]; detail = im[2].trim(); } else detail = raw;
  }
  const occ = s.match(/【第(\d+)處】/);
  const q = s.match(/【原文】\s*「([\s\S]*?)」/);
  const prop = s.match(/【提案】\s*「([\s\S]*?)」/);
  const note = s.match(/【備註】([\s\S]*?)(?:【原文】|【提案】|$)/);
  return {
    state: review ? "review" : "todo", intent, instruction: detail,
    occurrence: occ ? parseInt(occ[1], 10) : 1,
    quote: q ? q[1] : "", proposal: prop ? prop[1] : "", note: note ? note[1].trim() : "",
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
function queryMarks() { return [...queryByTag(TODO_TAG), ...queryByTag(PROP_TAG)]; }

function findBlockTextEl(uid) {
  const els = document.querySelectorAll('.rm-block-text, .roam-block');
  for (const el of els) if (el.id && el.id.endsWith(uid)) return el;
  for (const el of els) if (el.id && el.id.indexOf(uid) !== -1) return el;
  return document.querySelector('[id^="block-input"][id$="' + uid + '"]');
}
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
  const cls = m.state === "review" ? "ccm-underline-review" : "ccm-underline";
  let anchor = m.quote ? wrapNeedle(el, m.quote, m, cls) : null;
  if (!anchor) {
    el.classList.add(m.state === "review" ? "ccm-block-flag-review" : "ccm-block-flag");
    el.dataset.ccmChild = m.childUid; el.dataset.state = m.state;
    anchor = el;
  } else if (m.state === "todo") {
    anchor.addEventListener("click", (e) => { e.stopPropagation(); openEdit(m, anchor); });
  }
  attachBubble(anchor, m);
}

function attachBubble(anchorEl, m) {
  const makeBubble = () => {
    const b = document.createElement("div");
    b.className = "ccm-bubble" + (m.state === "review" ? " review" : "");
    if (m.state === "review") {
      const body = m.proposal ? ("→「" + m.proposal + "」") : (m.note || "(無內容)");
      b.innerHTML = `<div class="ccm-lbl">${m.intent}・待審</div><div class="ccm-ins"></div>` +
        `<div class="ccm-bactions"><button class="ccm-acc">✅ 接受</button><button class="ccm-ret">↩ 退回</button></div>`;
      b.querySelector(".ccm-ins").textContent = body;
      b.querySelector(".ccm-acc").onclick = (e) => { e.stopPropagation(); acceptMark(m); };
      b.querySelector(".ccm-ret").onclick = (e) => { e.stopPropagation(); openEdit(m, anchorEl); };
    } else {
      b.innerHTML = `<div class="ccm-lbl">${m.intent}・待CC</div><div class="ccm-ins"></div>` +
        `<div class="ccm-bactions"><button class="ccm-bedit">編輯</button><button class="ccm-bdel">刪除</button></div>`;
      b.querySelector(".ccm-ins").textContent = m.instruction || "(無指令)";
      b.querySelector(".ccm-bedit").onclick = (e) => { e.stopPropagation(); openEdit(m, anchorEl); };
      b.querySelector(".ccm-bdel").onclick = (e) => { e.stopPropagation(); deleteMark(m.childUid); };
    }
    overlayEl.appendChild(b);
    positionBubble(b, anchorEl);
    return b;
  };
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

// ── refresh ─────────────────────────────────────────────────
function clearDecorations() {
  document.querySelectorAll(".ccm-underline, .ccm-underline-review").forEach((s) => {
    const p = s.parentNode; if (!p) return;
    while (s.firstChild) p.insertBefore(s.firstChild, s);
    p.removeChild(s); p.normalize();
  });
  document.querySelectorAll(".ccm-block-flag, .ccm-block-flag-review").forEach((e) => {
    e.classList.remove("ccm-block-flag", "ccm-block-flag-review");
    delete e.dataset.ccmChild; delete e.dataset.state;
  });
  overlayEl.innerHTML = "";
}

function refreshDecorations(force) {
  if (!overlayEl) return;
  const rows = queryMarks();
  const curPage = currentPage();
  const pageUid = curPage && curPage.uid;
  const marks = [];
  for (const [cu, pu, s, pg, ps] of rows) {
    const m = parseMark(s);
    m.childUid = cu; m.parentUid = pu; m.parentStr = ps; m.pageUid = pg;
    marks.push(m);
  }
  const desired = marks.filter((m) => findBlockTextEl(m.parentUid));
  // 本頁計數：優先用 page uid 算全頁；抓不到頁就退回「畫面上的標記數」→ 有標記就一定顯示膠囊
  const counted = pageUid ? marks.filter((m) => m.pageUid === pageUid) : desired;
  const todoCount = counted.filter((m) => m.state === "todo").length;
  const reviewCount = counted.filter((m) => m.state === "review").length;
  const sig = desired.map((m) => m.childUid + ":" + m.state).sort().join("|");
  const cur = [];
  document.querySelectorAll(".ccm-underline, .ccm-underline-review, .ccm-block-flag, .ccm-block-flag-review")
    .forEach((e) => cur.push((e.dataset.child || e.dataset.ccmChild) + ":" + (e.dataset.state || "")));
  const same = sig === cur.sort().join("|");
  if (!force && same) { updatePill(todoCount, reviewCount); return; }

  applying = true;
  clearDecorations();
  for (const m of desired) { const el = findBlockTextEl(m.parentUid); if (el) decorateMark(el, m); }
  updatePill(todoCount, reviewCount);
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
async function acceptMark(m) {
  try {
    if (m.intent === "潤" && m.proposal) {
      const curStr = blockString(m.parentUid);
      let next;
      if (m.quote) { next = replaceNth(curStr, m.quote, m.proposal, m.occurrence); if (next === null) return toast("找不到原文，未套用（原稿可能已被改）"); }
      else next = m.proposal;
      await window.roamAlphaAPI.updateBlock({ block: { uid: m.parentUid, string: next } });
      await window.roamAlphaAPI.deleteBlock({ block: { uid: m.childUid } });
      toast("已接受並套用");
    } else if (m.intent === "接" && m.proposal) {
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
function markFromSelection(x, y, viaKeyboard) {
  const cap = captureSelection(viaKeyboard);
  if (!cap) { hidePanel(); hideTrigger(); return false; }
  pending = { mode: "create", marks: cap.marks, label: cap.label };
  panelIntent = "潤";
  if (viaKeyboard) { hideTrigger(); showPanel(x, y, cap.label, ""); return true; }
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
  if (e.altKey && e.code === "KeyM" && !e.ctrlKey && !e.metaKey) {
    e.preventDefault(); const p = keyboardAnchorXY(); markFromSelection(p.x, p.y, true); return;
  }
  if (e.altKey && (e.code === "ArrowDown" || e.code === "ArrowUp") && !e.ctrlKey && !e.metaKey) {
    if (!document.querySelector(".ccm-underline, .ccm-underline-review, .ccm-block-flag, .ccm-block-flag-review")) return;
    e.preventDefault();
    if (navEl && navEl.style.display === "none") { navEl.style.display = "flex"; navIdx = -1; }
    navGo(e.code === "ArrowDown" ? 1 : -1);
  }
}

// ── 面板 ─────────────────────────────────────────────────────
function openEdit(m, anchorEl) {
  pending = { mode: "edit", childUid: m.childUid, quote: m.quote, occurrence: m.occurrence };
  panelIntent = m.intent;
  const el = anchorEl || findBlockTextEl(m.parentUid);
  const r = el ? el.getBoundingClientRect() : { left: window.innerWidth / 2, bottom: 200, width: 0 };
  showPanel(r.left + window.scrollX + r.width / 2, r.bottom + window.scrollY, m.quote ? "「" + m.quote + "」" : "（整段）", m.instruction);
}
function setIntent(it) {
  if (!INTENTS.includes(it)) return;
  panelIntent = it;
  panelEl.querySelectorAll(".ccm-intents button").forEach((btn) => btn.classList.toggle("on", btn.dataset.intent === it));
  panelEl.querySelector(".ccm-hint").textContent = INTENT_HINT[it];
  panelEl.querySelector(".ccm-chips").style.display = it === "潤" ? "flex" : "none";
}
function showTrigger(x, y) { triggerBtn.style.display = "block"; triggerBtn.style.left = x + "px"; triggerBtn.style.top = y + "px"; }
function hideTrigger() { if (triggerBtn) triggerBtn.style.display = "none"; }
function showPanel(x, y, label, prefill) {
  const isEdit = pending && pending.mode === "edit";
  panelEl.querySelector(".ccm-head").textContent = isEdit ? "✏️ 修改標記" : "✏️ 請CC修改";
  panelEl.querySelector(".ccm-picked").textContent = label;
  panelEl.querySelector(".ccm-delete").style.display = isEdit ? "inline-block" : "none";
  setIntent(panelIntent);
  const ta = panelEl.querySelector("textarea");
  ta.value = prefill || "";
  panelEl.style.display = "block";
  panelEl.style.left = x + "px"; panelEl.style.top = (y + 12) + "px";
  setTimeout(() => { ta.focus(); ta.select(); }, 0);
}
function hidePanel() { if (panelEl) panelEl.style.display = "none"; pending = null; }
async function submitPanel() {
  const ta = panelEl.querySelector("textarea");
  const ins = ta.value.trim();
  const p = pending;
  if (!p) return hidePanel();
  try { window.getSelection().removeAllRanges(); } catch (e) {}
  hidePanel();
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
    return `${i + 1}. [block ${pu}] ${m.intent}｜指令：${m.instruction || "(無)"}｜${where}\n   目前內容：${ps}`;
  });
  const text =
    `請依 PROTOCOL v2 處理 Roam page「${pg.title}」（page uid: ${pg.uid}）的 ${rows.length} 個 #請cc修改 標記。\n` +
    `鐵律：不得修改任何原稿 block、不得刪標記。先完整讀整頁掌握上下文，再逐處依「意圖」回寫提案（潤=【提案】替換文／接=【提案】草稿／查議=【備註】結果＋來源），把該標記 tag 由 #請cc修改 改成 #cc提案；最後在 chat 回一份對帳清單。\n\n` +
    `共 ${rows.length} 處：\n` + lines.join("\n");
  try { await navigator.clipboard.writeText(text); toast(`已複製本頁 ${rows.length} 個待處理標記給 CC`); }
  catch (e) { console.warn(e); toast("複製失敗（剪貼簿權限）"); }
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
  triggerBtn.className = "ccm-trigger"; triggerBtn.textContent = "✏️ 請CC修改"; triggerBtn.style.display = "none";
  triggerBtn.addEventListener("mousedown", (e) => e.preventDefault());
  triggerBtn.addEventListener("click", () => {
    if (!pending) return hideTrigger();
    const r = triggerBtn.getBoundingClientRect(); hideTrigger();
    showPanel(r.left + window.scrollX, r.top + window.scrollY, pending.label || "", "");
  });
  document.body.appendChild(triggerBtn);

  panelEl = document.createElement("div"); panelEl.className = "ccm-panel";
  panelEl.innerHTML =
    '<div class="ccm-head">✏️ 請CC修改</div>' +
    '<div class="ccm-intents">' + INTENTS.map((it, i) => `<button data-intent="${it}" title="⌥${i + 1}">${it}</button>`).join("") + '</div>' +
    '<div class="ccm-hint"></div>' +
    '<div class="ccm-picked"></div>' +
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
    '<button class="ccm-nav-copy" title="打包本頁待處理標記給 CC">📋</button>';
  navEl.querySelector(".ccm-nav-prev").onclick = () => navGo(-1);
  navEl.querySelector(".ccm-nav-next").onclick = () => navGo(1);
  navEl.querySelector(".ccm-nav-copy").onclick = () => copyMarksPrompt();
  document.body.appendChild(navEl);

  toggleBtn = document.createElement("div"); toggleBtn.className = "ccm-toggle";
  toggleBtn.title = "開 / 關標記模式（⌥M 隨時可標）"; toggleBtn.onclick = () => setActive(!active);
  document.body.appendChild(toggleBtn); updateToggle();
}

function updatePill(todo, review) {
  if (!pillEl) return;
  if (!todo && !review) { pillEl.style.display = "none"; if (navEl) navEl.style.display = "none"; return; }
  pillEl.style.display = "block";
  pillEl.innerHTML = `📝 待處理 <b>${todo}</b>` + (review ? ` · <span class="ccm-rev">待審 ${review}</span>` : "");
}

// ── 上下導覽 ─────────────────────────────────────────────────
function navMarks() {
  const els = Array.from(document.querySelectorAll(".ccm-underline, .ccm-underline-review, .ccm-block-flag, .ccm-block-flag-review"));
  els.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  return els;
}
function navGo(dir) {
  const els = navMarks();
  if (!els.length) { updateNavLabel(0); return; }
  navIdx = (navIdx + dir + els.length) % els.length;
  const el = els[navIdx];
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  const prev = el.style.background; el.style.background = "#ffd54a";
  setTimeout(() => { el.style.background = prev; }, 900);
  updateNavLabel(els.length);
}
function updateNavLabel(total) { const lbl = navEl && navEl.querySelector(".ccm-nav-label"); if (lbl) lbl.textContent = total ? (navIdx + 1) + "/" + total : "0"; }
function toggleNav() { if (!navEl) return; if (navEl.style.display !== "none") { navEl.style.display = "none"; return; } navEl.style.display = "flex"; navIdx = -1; navGo(1); }

// ── 開關 ─────────────────────────────────────────────────────
function setActive(v) { active = v; try { api.settings.set("active", v); } catch (e) {} updateToggle(); if (!v) { hidePanel(); hideTrigger(); } }
function updateToggle() { if (!toggleBtn) return; toggleBtn.textContent = active ? "✏️ 標記模式：開" : "✏️ 標記模式：關"; toggleBtn.classList.toggle("on", active); }

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
  .ccm-overlay{position:absolute;top:0;left:0;width:0;height:0;z-index:9990;pointer-events:none;}
  .ccm-bubble{position:absolute;width:max-content;max-width:280px;background:#fff;border:1px solid #f0c453;border-radius:9px;
    box-shadow:0 6px 20px rgba(16,22,26,.18);padding:7px 11px 8px;font-size:12.5px;line-height:1.5;color:#33404d;
    transform:translate(-50%,-100%);pointer-events:auto;z-index:9991;}
  .ccm-bubble.review{border-color:#8ad9b3;}
  .ccm-bubble .ccm-lbl{white-space:nowrap;font-size:10.5px;font-weight:800;color:#b5820c;margin-bottom:2px;}
  .ccm-bubble.review .ccm-lbl{color:#1a7f54;}
  .ccm-bubble .ccm-ins{font-weight:600;white-space:normal;}
  .ccm-bubble::after{content:"";position:absolute;left:50%;bottom:-7px;transform:translateX(-50%);border:7px solid transparent;border-top-color:#fff;filter:drop-shadow(0 1px 0 #f0c453);}
  .ccm-bubble.review::after{filter:drop-shadow(0 1px 0 #8ad9b3);}
  .ccm-bubble .ccm-bactions{display:flex;gap:6px;margin-top:7px;}
  .ccm-bubble .ccm-bactions button{font-size:11px;cursor:pointer;border-radius:6px;padding:3px 11px;border:1px solid transparent;font-weight:700;}
  .ccm-bedit,.ccm-acc{background:#2b7de0;color:#fff;}
  .ccm-acc{background:#22a06b;}
  .ccm-bedit:hover{background:#1e6fd0;} .ccm-acc:hover{background:#1a8558;}
  .ccm-bdel,.ccm-ret{background:#fff;color:#e5484d;border:1px solid #f3c0c2 !important;}
  .ccm-ret{color:#8a6d3b;border-color:#e5cf9e !important;}
  .ccm-bdel:hover,.ccm-ret:hover{background:#fbf4e8;}
  .ccm-trigger{position:absolute;z-index:9996;background:#2b7de0;color:#fff;font-size:12px;font-weight:700;padding:4px 10px;border-radius:999px;box-shadow:0 4px 14px rgba(16,22,26,.22);cursor:pointer;user-select:none;white-space:nowrap;transform:translate(-50%,-100%);}
  .ccm-trigger:hover{background:#1e6fd0;}
  .ccm-panel{position:absolute;z-index:9995;width:300px;background:#fff;border:1px solid #d5dbe2;border-radius:11px;box-shadow:0 10px 30px rgba(16,22,26,.22);padding:11px 12px 12px;transform:translateX(-50%);}
  .ccm-panel .ccm-head{font-size:12px;font-weight:800;color:#2b7de0;margin-bottom:7px;}
  .ccm-intents{display:flex;gap:6px;margin-bottom:5px;}
  .ccm-intents button{flex:1;font-size:13px;font-weight:800;cursor:pointer;border:1px solid #dbe1e8;background:#f7f9fb;border-radius:7px;padding:5px 0;color:#4a5560;}
  .ccm-intents button.on{background:#2b7de0;color:#fff;border-color:#2b7de0;}
  .ccm-hint{font-size:11px;color:#98a2ac;margin-bottom:7px;}
  .ccm-panel .ccm-picked{font-size:11.5px;color:#8a94a0;background:#f4f6f8;border-radius:6px;padding:4px 7px;margin-bottom:8px;max-height:42px;overflow:hidden;}
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
  .ccm-pill b{color:#c47f0a;} .ccm-pill .ccm-rev{color:#1a7f54;font-weight:700;}
  .ccm-nav{position:fixed;right:18px;bottom:98px;z-index:9994;display:flex;align-items:center;gap:6px;background:#fff;border:1px solid #d5dbe2;border-radius:999px;padding:4px 8px;box-shadow:0 4px 14px rgba(16,22,26,.16);}
  .ccm-nav button{width:26px;height:26px;border:none;border-radius:50%;background:#eef2f6;color:#37424d;cursor:pointer;font-size:12px;line-height:1;}
  .ccm-nav button:hover{background:#2b7de0;color:#fff;}
  .ccm-nav-label{font-size:12px;font-weight:700;color:#58636e;min-width:34px;text-align:center;}
  .ccm-toggle{position:fixed;right:18px;bottom:18px;z-index:9994;background:#e9edf1;border:1px solid #d5dbe2;color:#58636e;font-size:12.5px;font-weight:700;padding:6px 13px;border-radius:999px;box-shadow:0 4px 14px rgba(16,22,26,.14);cursor:pointer;user-select:none;transition:background .12s;}
  .ccm-toggle.on{background:#2b7de0;border-color:#2b7de0;color:#fff;box-shadow:0 4px 16px rgba(43,125,224,.35);}
  .ccm-toast{position:fixed;left:50%;bottom:46px;transform:translateX(-50%);z-index:9998;background:#1f2937;color:#fff;font-size:12.5px;font-weight:600;padding:8px 16px;border-radius:999px;box-shadow:0 6px 20px rgba(16,22,26,.3);opacity:1;transition:opacity .4s;pointer-events:none;}
  `;
  document.head.appendChild(styleEl);
}

// ── observer ─────────────────────────────────────────────────
function startObserver() {
  const root = document.querySelector(".roam-app") || document.body;
  observer = new MutationObserver(() => { if (applying) return; debouncedRefresh(); });
  observer.observe(root, { childList: true, subtree: true, characterData: true });
  scrollBound = () => { debouncedRefresh(); };
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
  document.addEventListener("mouseup", onMouseUp);
  keyBound = onKeyDown; document.addEventListener("keydown", keyBound, true);
  startObserver();
  const cmds = [
    { label: "請CC修改：開關標記模式", callback: () => setActive(!active) },
    { label: "請CC修改：標記游標處 (⌥M)", callback: () => { const p = keyboardAnchorXY(); markFromSelection(p.x, p.y, true); } },
    { label: "請CC修改：下一個 (⌥↓)", callback: () => navGo(1) },
    { label: "請CC修改：上一個 (⌥↑)", callback: () => navGo(-1) },
    { label: "請CC修改：打包本頁待處理給 CC", callback: () => copyMarksPrompt() },
    { label: "請CC修改：重整標記", callback: () => refreshDecorations(true) },
  ];
  cmds.forEach((c) => window.roamAlphaAPI.ui.commandPalette.addCommand(c));
  setTimeout(() => refreshDecorations(true), 400);
  console.log("[請CC修改] v2 loaded");
}
function onunload() {
  document.removeEventListener("mouseup", onMouseUp);
  if (keyBound) document.removeEventListener("keydown", keyBound, true);
  if (observer) observer.disconnect();
  if (scrollBound) { window.removeEventListener("scroll", scrollBound, true); window.removeEventListener("resize", scrollBound); }
  clearDecorations();
  [styleEl, overlayEl, panelEl, pillEl, triggerBtn, toggleBtn, navEl].forEach((e) => e && e.remove());
  const labels = ["請CC修改：開關標記模式", "請CC修改：標記游標處 (⌥M)", "請CC修改：下一個 (⌥↓)", "請CC修改：上一個 (⌥↑)", "請CC修改：打包本頁待處理給 CC", "請CC修改：重整標記"];
  try { labels.forEach((l) => window.roamAlphaAPI.ui.commandPalette.removeCommand({ label: l })); } catch (e) {}
  console.log("[請CC修改] unloaded");
}

export default { onload, onunload };
