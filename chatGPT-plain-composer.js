// ==UserScript==
// @name         ChatGPT Plain Text Composer (Hide ProseMirror)
// @namespace    vm-chatgpt-plain-composer
// @version      0.6
// @description  Replace ChatGPT composer with a plain textarea for smoother typing. Adds autogrow + per-chat drafts + cleanup + correct multiline sending + throttled MutationObserver + non-overlapping toggle UX + aligns with main column (sidebar-aware).
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  // ---- Config ----
  const CONFIG = {
    // NOTE: panelWidth is now "auto-aligned" to main column; this is only used as fallback
    fallbackWidth: "900px",

    // Autogrow behavior
    minHeightPx: 30,
    maxHeightVh: 35,

    fontSize: "15px",
    lineHeight: "1.4",
    hideOriginalComposer: true,

    // Draft persistence
    persistDrafts: true,
    clearDraftOnSend: true,
    draftSaveDebounceMs: 250,

    // Cleanup / retention
    draftTtlDays: 30,
    maxDraftEntries: 200,

    // Hotkeys
    sendHotkeyRequiresCtrlOrCmd: true,

    // MutationObserver throttling
    mutationThrottleMs: 200,

    // Toggle UX
    hidePlainComposerWhenOriginalShown: true,
    showReturnButtonWhenOriginalShown: true,

    // Alignment
    alignToMainColumn: true,
  };

  const STATE = {
    installed: false,
    wrapperEl: null,
    textareaEl: null,
    lastKnownComposerForm: null,

    draftKey: null,
    saveTimer: null,
    lastSavedValue: null,

    cleanedThisSession: false,

    // Toggle UX state
    originalVisibleByUser: false,
    returnBtnEl: null,
  };

  // ---- Helpers ----
  function log(...args) {
    console.log("[PlainComposer]", ...args);
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function qs(sel, root = document) {
    return root.querySelector(sel);
  }

  function getComposerForm() {
    return (
      qs('form.group\\/composer') ||
      qs('form[data-type="unified-composer"]') ||
      null
    );
  }

  function getRealPromptEditable() {
    return (
      qs('div[contenteditable="true"]#prompt-textarea') ||
      qs('div[contenteditable="true"][data-virtualkeyboard="true"]') ||
      qs('div[contenteditable="true"].ProseMirror') ||
      null
    );
  }

  function getSendButton(composerForm) {
    const withinForm =
      composerForm &&
      (qs('button[data-testid="send-button"]', composerForm) ||
        qs('button[aria-label="Send message"]', composerForm) ||
        qs('button[type="submit"]', composerForm));

    if (withinForm) return withinForm;

    return (
      qs('button[data-testid="send-button"]') ||
      qs('button[aria-label="Send message"]') ||
      qs('button[type="submit"]') ||
      null
    );
  }

  function hideOriginalComposer(composerForm) {
    if (!composerForm) return;
    if (!composerForm.dataset.plainComposerHidden) {
      composerForm.dataset.plainComposerHidden = "1";
      composerForm.style.display = "none";
    }
  }

  function showOriginalComposer(composerForm) {
    if (!composerForm) return;
    if (composerForm.dataset.plainComposerHidden) {
      delete composerForm.dataset.plainComposerHidden;
      composerForm.style.display = "";
    }
  }

  function styleButton(btn) {
    btn.style.border = "1px solid rgba(255,255,255,0.2)";
    btn.style.borderRadius = "8px";
    btn.style.padding = "8px 10px";
    btn.style.cursor = "pointer";
    btn.style.background = "rgba(255,255,255,0.10)";
    btn.style.color = "#fff";
    btn.style.fontSize = "13px";
    btn.style.userSelect = "none";
  }

  // ---- Drafts ----
  function getConversationId() {
    const path = location.pathname;

    const m1 = path.match(/\/c\/([a-zA-Z0-9_-]+)/);
    if (m1) return m1[1];

    const m2 = path.match(/\/chat\/([a-zA-Z0-9_-]+)/);
    if (m2) return m2[1];

    return path || "unknown";
  }

  function computeDraftKey() {
    const cid = getConversationId();
    return `vm_plain_composer_draft:${location.host}:${cid}`;
  }

  function nowMs() {
    return Date.now();
  }

  function ttlMs() {
    return CONFIG.draftTtlDays * 24 * 60 * 60 * 1000;
  }

  function isOurDraftKey(key) {
    return typeof key === "string" && key.startsWith("vm_plain_composer_draft:");
  }

  function safeJsonParse(s) {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  }

  function cleanupOldDraftsOncePerSession() {
    if (!CONFIG.persistDrafts) return;
    if (STATE.cleanedThisSession) return;

    STATE.cleanedThisSession = true;

    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (isOurDraftKey(k)) keys.push(k);
    }

    const entries = [];
    const cutoff = nowMs() - ttlMs();

    for (const k of keys) {
      const raw = localStorage.getItem(k);
      if (!raw) continue;

      const obj = safeJsonParse(raw);
      if (!obj || typeof obj !== "object") {
        try { localStorage.removeItem(k); } catch {}
        continue;
      }

      const ts = Number(obj.ts);
      const text = typeof obj.text === "string" ? obj.text : "";

      if (!ts || ts < cutoff || text.length === 0) {
        try { localStorage.removeItem(k); } catch {}
        continue;
      }

      entries.push({ key: k, ts });
    }

    if (entries.length > CONFIG.maxDraftEntries) {
      entries.sort((a, b) => b.ts - a.ts);
      const toRemove = entries.slice(CONFIG.maxDraftEntries);
      for (const e of toRemove) {
        try { localStorage.removeItem(e.key); } catch {}
      }
    }
  }

  function loadDraftIfAny() {
    if (!CONFIG.persistDrafts || !STATE.textareaEl) return;

    cleanupOldDraftsOncePerSession();

    const key = computeDraftKey();
    STATE.draftKey = key;

    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;

      const obj = safeJsonParse(raw);
      if (obj && typeof obj.text === "string" && obj.text.length > 0) {
        STATE.textareaEl.value = obj.text;
        STATE.lastSavedValue = obj.text;
        autogrow(STATE.textareaEl);
      }
    } catch (e) {
      log("Draft load failed:", e);
    }
  }

  function saveDraftDebounced() {
    if (!CONFIG.persistDrafts || !STATE.textareaEl) return;
    if (!STATE.draftKey) STATE.draftKey = computeDraftKey();

    const val = STATE.textareaEl.value;
    if (val === STATE.lastSavedValue) return;

    if (STATE.saveTimer) clearTimeout(STATE.saveTimer);

    STATE.saveTimer = setTimeout(() => {
      try {
        const payload = JSON.stringify({ text: val, ts: nowMs() });
        localStorage.setItem(STATE.draftKey, payload);
        STATE.lastSavedValue = val;
      } catch (e) {
        log("Draft save failed:", e);
      }
    }, CONFIG.draftSaveDebounceMs);
  }

  function clearDraft() {
    if (!CONFIG.persistDrafts) return;
    if (!STATE.draftKey) return;

    try {
      localStorage.removeItem(STATE.draftKey);
      STATE.lastSavedValue = "";
    } catch (e) {
      log("Draft clear failed:", e);
    }
  }

  // ---- Autogrow ----
  function autogrow(textarea) {
    if (!textarea) return;
    textarea.style.height = "auto";
    const maxPx = Math.round((window.innerHeight * CONFIG.maxHeightVh) / 100);
    const newPx = Math.min(Math.max(textarea.scrollHeight, CONFIG.minHeightPx), maxPx);
    textarea.style.height = `${newPx}px`;
  }

  // ---- Robust ProseMirror injection (keeps newlines & enables Send) ----
  function setProseMirrorMultilineContent(pmEl, text) {
    pmEl.focus();

    const normalized = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    pmEl.innerHTML = "";

    const lines = normalized.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const p = document.createElement("p");
      if (line.length === 0) {
        p.appendChild(document.createElement("br"));
      } else {
        p.textContent = line;
      }
      pmEl.appendChild(p);
    }

    pmEl.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
      })
    );
    pmEl.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // ---- Alignment (sidebar-aware) ----
  function getMainContentAnchor() {
    // This is the container you found: div[class*="@container/main"]
    const main =
      document.querySelector('div[class*="@container/main"]') ||
      document.querySelector('div[class*="container/main"]');

    if (main) return main;

    // fallback: composer’s parent
    const form = getComposerForm();
    if (form) return form.parentElement || form;

    return document.body;
  }

  function syncOverlayToMainAnchor() {
    if (!CONFIG.alignToMainColumn) return;
    if (!STATE.wrapperEl) return;

    const anchor = getMainContentAnchor();
    if (!anchor) return;

    const rect = anchor.getBoundingClientRect();
    if (!rect.width || rect.width < 200) return;

    // We use a nested fixed-position aligner inside wrapper.
    let aligner = STATE.wrapperEl.querySelector("#vm-plain-aligner");

    if (!aligner) {
      aligner = document.createElement("div");
      aligner.id = "vm-plain-aligner";
      aligner.style.position = "fixed";
      aligner.style.bottom = "0";
      aligner.style.zIndex = "999999";
      aligner.style.padding = "10px";
      aligner.style.boxSizing = "border-box";
      aligner.style.pointerEvents = "none";

      // Move panel into aligner
      const panel = STATE.wrapperEl.firstElementChild;
      STATE.wrapperEl.innerHTML = "";
      aligner.appendChild(panel);
      STATE.wrapperEl.appendChild(aligner);

      // Make panel interactive
      panel.style.pointerEvents = "auto";
      panel.style.width = "100%";
      panel.style.maxWidth = "unset";
      panel.style.margin = "0";
    }

    aligner.style.left = `${Math.round(rect.left)}px`;
    aligner.style.width = `${Math.round(rect.width)}px`;
  }

  // ---- Toggle UX helpers ----
  function setPlainComposerVisible(visible) {
    if (!STATE.wrapperEl) return;
    STATE.wrapperEl.style.display = visible ? "block" : "none";
  }

  function ensureReturnButton() {
    if (!CONFIG.showReturnButtonWhenOriginalShown) return;
    if (STATE.returnBtnEl) return STATE.returnBtnEl;

    const btn = document.createElement("button");
    btn.id = "vm-plain-composer-return-btn";
    btn.textContent = "Plain Composer";
    btn.title = "Return to the plain composer overlay";

    btn.style.position = "fixed";
    btn.style.right = "14px";
    btn.style.bottom = "14px";
    btn.style.zIndex = "1000000";
    btn.style.border = "1px solid rgba(255,255,255,0.25)";
    btn.style.borderRadius = "999px";
    btn.style.padding = "8px 12px";
    btn.style.cursor = "pointer";
    btn.style.background = "rgba(20,20,20,0.85)";
    btn.style.color = "#fff";
    btn.style.fontSize = "13px";
    btn.style.boxShadow = "0 10px 28px rgba(0,0,0,0.35)";
    btn.style.backdropFilter = "blur(6px)";
    btn.style.display = "none";

    btn.addEventListener("click", () => {
      STATE.originalVisibleByUser = false;

      const composerForm = getComposerForm();
      if (composerForm && CONFIG.hideOriginalComposer) {
        hideOriginalComposer(composerForm);
      }

      btn.style.display = "none";
      setPlainComposerVisible(true);

      // Align again (sidebar might have changed)
      syncOverlayToMainAnchor();

      if (STATE.textareaEl) STATE.textareaEl.focus();
    });

    document.body.appendChild(btn);
    STATE.returnBtnEl = btn;
    return btn;
  }

  function showReturnButton(show) {
    const btn = ensureReturnButton();
    if (!btn) return;
    btn.style.display = show ? "block" : "none";
  }

  // ---- UI Creation ----
  function createPlainComposerUI() {
    if (STATE.wrapperEl) return STATE.wrapperEl;

    const wrapper = document.createElement("div");
    wrapper.id = "vm-plain-composer-wrapper";
    wrapper.style.position = "fixed";
    wrapper.style.left = "0";
    wrapper.style.right = "0";
    wrapper.style.bottom = "0";
    wrapper.style.zIndex = "999999";
    wrapper.style.display = "block";
    wrapper.style.padding = "0";
    wrapper.style.pointerEvents = "none"; // aligner manages pointer-events

    const panel = document.createElement("div");
    panel.style.pointerEvents = "auto";
    panel.style.width = CONFIG.fallbackWidth;
    panel.style.maxWidth = "calc(100vw - 20px)";
    panel.style.border = "1px solid rgba(128,128,128,0.35)";
    panel.style.borderRadius = "10px";
    panel.style.background = "rgba(20,20,20,0.85)";
    panel.style.backdropFilter = "blur(6px)";
    panel.style.padding = "10px";
    panel.style.boxShadow = "0 10px 28px rgba(0,0,0,0.35)";
    panel.style.display = "flex";
    panel.style.flexDirection = "column";
    panel.style.gap = "8px";

    const textarea = document.createElement("textarea");
    textarea.id = "vm-plain-composer";
    textarea.placeholder = "Enter your prompt... (Ctrl/Cmd+Enter to send)";
    textarea.spellcheck = true;
    textarea.style.width = "100%";
    textarea.style.height = `${CONFIG.minHeightPx}px`;
    textarea.style.resize = "none";
    textarea.style.fontSize = CONFIG.fontSize;
    textarea.style.lineHeight = CONFIG.lineHeight;
    textarea.style.fontFamily =
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";
    textarea.style.border = "1px solid rgba(255,255,255,0.18)";
    textarea.style.borderRadius = "8px";
    textarea.style.padding = "10px";
    textarea.style.outline = "none";
    textarea.style.color = "#fff";
    textarea.style.background = "rgba(0,0,0,0.35)";

    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.justifyContent = "space-between";
    row.style.alignItems = "center";
    row.style.gap = "10px";

    const leftInfo = document.createElement("div");
    leftInfo.style.fontSize = "12px";
    leftInfo.style.opacity = "0.85";
    leftInfo.style.color = "#fff";
    leftInfo.textContent =
      "Plain composer active — Ctrl/Cmd+Enter to send — Esc to toggle the original composer";

    const btnRow = document.createElement("div");
    btnRow.style.display = "flex";
    btnRow.style.gap = "8px";

    const toggleBtn = document.createElement("button");
    toggleBtn.textContent = "Toggle Original";
    styleButton(toggleBtn);

    const sendBtn = document.createElement("button");
    sendBtn.textContent = "Send";
    styleButton(sendBtn);

    btnRow.appendChild(toggleBtn);
    btnRow.appendChild(sendBtn);

    row.appendChild(leftInfo);
    row.appendChild(btnRow);

    panel.appendChild(textarea);
    panel.appendChild(row);
    wrapper.appendChild(panel);
    document.body.appendChild(wrapper);

    sendBtn.addEventListener("click", () => sendPlainMessage());
    toggleBtn.addEventListener("click", () => toggleOriginalComposer());

    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const modifier = e.ctrlKey || e.metaKey;
        if (CONFIG.sendHotkeyRequiresCtrlOrCmd && modifier) {
          e.preventDefault();
          sendPlainMessage();
        }
      }

      if (e.key === "Escape") {
        e.preventDefault();
        toggleOriginalComposer();
      }
    });

    textarea.addEventListener("input", () => {
      autogrow(textarea);
      saveDraftDebounced();
    });

    window.addEventListener("resize", () => {
      autogrow(textarea);
      syncOverlayToMainAnchor();
    });

    STATE.wrapperEl = wrapper;
    STATE.textareaEl = textarea;

    loadDraftIfAny();
    autogrow(textarea);

    // Ensure return button exists (hidden by default)
    ensureReturnButton();

    // Align immediately (sidebar-aware)
    syncOverlayToMainAnchor();

    return wrapper;
  }

  // ---- Sending ----
  async function sendPlainMessage() {
    const text = STATE.textareaEl?.value ?? "";
    if (!text.trim()) return;

    const composerForm = getComposerForm();
    const prompt = getRealPromptEditable();
    if (!composerForm || !prompt) {
      log("Composer not found; cannot send.");
      return;
    }

    const wasHidden = composerForm.style.display === "none";
    if (wasHidden) showOriginalComposer(composerForm);

    setProseMirrorMultilineContent(prompt, text);

    await sleep(80);

    const sendBtn = getSendButton(composerForm);
    if (!sendBtn) {
      log("Send button not found.");
      if (wasHidden && CONFIG.hideOriginalComposer) hideOriginalComposer(composerForm);
      return;
    }

    if (sendBtn.disabled) {
      await sleep(120);
    }

    sendBtn.click();

    if (CONFIG.clearDraftOnSend) clearDraft();

    STATE.textareaEl.value = "";
    STATE.lastSavedValue = "";
    autogrow(STATE.textareaEl);

    if (!STATE.originalVisibleByUser && wasHidden && CONFIG.hideOriginalComposer) {
      await sleep(40);
      hideOriginalComposer(composerForm);
    }
  }

  function toggleOriginalComposer() {
    const composerForm = getComposerForm();
    if (!composerForm) return;

    const currentlyHidden = composerForm.style.display === "none";

    if (currentlyHidden) {
      // Show original
      showOriginalComposer(composerForm);
      STATE.originalVisibleByUser = true;

      if (CONFIG.hidePlainComposerWhenOriginalShown) setPlainComposerVisible(false);
      showReturnButton(true);
    } else {
      // Hide original and return to plain
      if (CONFIG.hideOriginalComposer) hideOriginalComposer(composerForm);
      STATE.originalVisibleByUser = false;

      showReturnButton(false);
      setPlainComposerVisible(true);

      // Align after toggling
      syncOverlayToMainAnchor();

      if (STATE.textareaEl) STATE.textareaEl.focus();
    }
  }

  // ---- Install & Observe ----
  function installIfNeeded() {
    const composerForm = getComposerForm();
    if (!composerForm) return;

    STATE.lastKnownComposerForm = composerForm;
    createPlainComposerUI();

    if (CONFIG.hideOriginalComposer && !STATE.originalVisibleByUser) {
      hideOriginalComposer(composerForm);
    }

    // Align continuously as layout changes (sidebar open/close)
    syncOverlayToMainAnchor();

    STATE.installed = true;
  }

  function handleMutations() {
    const composerForm = getComposerForm();
    if (!composerForm) return;

    if (!STATE.installed) {
      installIfNeeded();
      return;
    }

    if (STATE.lastKnownComposerForm !== composerForm) {
      STATE.lastKnownComposerForm = composerForm;
      if (CONFIG.hideOriginalComposer && !STATE.originalVisibleByUser) {
        hideOriginalComposer(composerForm);
      }
    }

    // Sidebar/layout changes: keep aligned
    syncOverlayToMainAnchor();

    // If URL changed (new conversation), update key + load draft
    const newKey = computeDraftKey();
    if (CONFIG.persistDrafts && STATE.draftKey && newKey !== STATE.draftKey) {
      STATE.draftKey = newKey;
      loadDraftIfAny();
    }
  }

  function makeThrottledHandler(fn, intervalMs) {
    let scheduled = false;
    let lastRun = 0;

    return function throttled() {
      const now = Date.now();
      const elapsed = now - lastRun;

      if (elapsed >= intervalMs) {
        lastRun = now;
        scheduled = false;
        fn();
        return;
      }

      if (!scheduled) {
        scheduled = true;
        setTimeout(() => {
          lastRun = Date.now();
          scheduled = false;
          fn();
        }, Math.max(0, intervalMs - elapsed));
      }
    };
  }

  function run() {
    installIfNeeded();

    const throttledMutationHandler = makeThrottledHandler(
      handleMutations,
      CONFIG.mutationThrottleMs
    );

    const observer = new MutationObserver(throttledMutationHandler);
    observer.observe(document.documentElement, { childList: true, subtree: true });

    log("Initialized v0.6 (sidebar-aware alignment).", {
      mutationThrottleMs: CONFIG.mutationThrottleMs,
    });
  }

  run();
})();
