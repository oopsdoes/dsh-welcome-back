/**
 * dsh-welcome-back — browser half for DeepSeek Harness.
 *
 * Scope:
 * - only the currently selected DSH session;
 * - only the latest rendered conversation message;
 * - no external files, long-term memory, other sessions, or background app.
 *
 * The plugin runs only while DSH itself is open. It stores a per-session
 * timestamp plus a bounded last-message snapshot in browser localStorage.
 */
window.__ModuleLoader__.load({
  id: "dsh-welcome-back",
  factory: () => {
    const module = { exports: {} };
    const exports = module.exports;

    const VERSION = "0.2.0";
    const STORAGE_PREFIX = "dsh-welcome-back:v2:";
    const CONFIG_KEY = `${STORAGE_PREFIX}config`;
    const SESSION_KEY_PREFIX = `${STORAGE_PREFIX}session:`;
    const STYLE_ID = "dsh-welcome-back-style";
    const OVERLAY_ID = "dsh-welcome-back-overlay";
    const SETTINGS_ID = "dsh-welcome-back-settings";
    const GEAR_ID = "dsh-welcome-back-gear";
    const TRANSCRIPT_SELECTOR = '[data-slot="conversation.session"]';
    /**
     * `data-chat-turn` is deliberately broad in DSH. It also appears on the
     * "turn-process" disclosure that renders tool status, completion time and
     * token usage. Read only normal chat-flow entries and reject descendants
     * of process containers as a second structural guard.
     */
    const MESSAGE_SELECTOR = '[data-chat-flow-kind]:not([data-chat-flow-kind="turn-process"])';
    const PROCESS_SELECTOR = '[data-chat-flow-kind="turn-process"], [data-step-process]';
    const MAX_SNAPSHOT_CHARS = 900;
    const SESSION_POLL_MS = 700;

    const DEFAULT_CONFIG = Object.freeze({
      enabled: true,
      thresholdMinutes: 180,
      repeatMinutes: 30,
      showDuration: true,
      greeting: "你好，欢迎回归。",
      scopeMode: "today-active",
    });

    let ctxRef = null;
    let selectedSessionId = null;
    let observer = null;
    let observationTimer = null;
    let sessionPollTimer = null;
    let showingForSession = null;
    const sessionBaselines = new Map();

    function safeJson(value, fallback) {
      try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" ? parsed : fallback;
      } catch {
        return fallback;
      }
    }

    function loadConfig() {
      const raw = safeJson(localStorage.getItem(CONFIG_KEY), {});
      const threshold = Number(raw.thresholdMinutes);
      const repeat = Number(raw.repeatMinutes);
      return {
        enabled: raw.enabled !== false,
        thresholdMinutes: Number.isFinite(threshold) && threshold >= 1 ? Math.floor(threshold) : DEFAULT_CONFIG.thresholdMinutes,
        repeatMinutes: Number.isFinite(repeat) && repeat >= 1 ? Math.floor(repeat) : DEFAULT_CONFIG.repeatMinutes,
        showDuration: raw.showDuration !== false,
        greeting: typeof raw.greeting === "string" && raw.greeting.trim() !== "" ? raw.greeting.trim() : DEFAULT_CONFIG.greeting,
        scopeMode: ["all", "today-active", "manual"].includes(raw.scopeMode)
          ? raw.scopeMode
          : DEFAULT_CONFIG.scopeMode,
      };
    }

    function saveConfig(next) {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(next));
    }

    function sessionKey(sessionId) {
      return `${SESSION_KEY_PREFIX}${encodeURIComponent(sessionId)}`;
    }

    function loadSessionState(sessionId) {
      return safeJson(localStorage.getItem(sessionKey(sessionId)), null);
    }

    function saveSessionState(sessionId, next) {
      localStorage.setItem(sessionKey(sessionId), JSON.stringify(next));
    }

    function currentSessionId(ctx) {
      try {
        const uiSession = ctx?.get?.("uiSession");
        const current = uiSession?.adapter?.current?.getSnapshot?.();
        if (typeof current?.key === "string" && current.key !== "") return current.key;
      } catch {}
      try {
        const sessions = ctx?.get?.("sessions");
        const current = sessions?.list?.getSnapshot?.()?.current;
        if (typeof current === "string" && current !== "") return current;
      } catch {}
      return null;
    }

    function messageRole(row) {
      const explicit = row.getAttribute("data-role") || row.getAttribute("data-message-role") || "";
      if (/user|human/i.test(explicit)) return "用户";
      if (/assistant|model|ai/i.test(explicit)) return "助手";
      const classes = String(row.className || "");
      if (/(^|[\s_-])user([\s_-]|$)/i.test(classes)) return "用户";
      if (/(^|[\s_-])assistant|(^|[\s_-])model([\s_-]|$)/i.test(classes)) return "助手";
      return "对话";
    }

    /**
     * DSH appends non-conversation status text to some chat rows, for example:
     * "用量 18.3K tok 23:20" or "已完成，用时 4 秒".
     *
     * Those are UI telemetry, not something the user or model said. Preserve
     * message line breaks while removing telemetry-only lines. A row that has
     * no remaining content must be skipped in favour of the preceding row.
     */
    function isStatusOnlyLine(line) {
      const value = line.replace(/\s+/g, " ").trim();
      if (!value) return true;
      if (/^(?:用量|usage)\s*[\d.,]+\s*[KMG]?\s*(?:tok|tokens?)\b.*$/i.test(value)) return true;
      if (/^(?:(?:已完成|completed|完成)\s*){1,2}(?:[,，·]?\s*(?:用时|耗时|duration|took)\s*[:：]?\s*[\d.]+\s*(?:毫秒|ms|秒|s|分钟|min|小时|h))?\s*$/i.test(value)) return true;
      if (/^(?:用时|耗时|duration|took)\s*[:：]?\s*[\d.]+\s*(?:毫秒|ms|秒|s|分钟|min|小时|h).*$/i.test(value)) return true;
      if (/^(?:\d{1,2}:){1,2}\d{2}(?::\d{2})?$/.test(value)) return true;
      return false;
    }

    function substantiveTextOf(row) {
      const raw = String(row.innerText || row.textContent || "").replace(/\r/g, "");
      const lines = raw
        .split(/\n+/)
        .map((line) => line.replace(/\s+/g, " ").trim())
        .filter((line) => !isStatusOnlyLine(line));
      return lines.join("\n").trim();
    }

    function isSubstantiveMessageRow(row) {
      if (!(row instanceof HTMLElement)) return false;
      if (row.hidden || row.closest("[hidden]")) return false;
      if (row.matches(PROCESS_SELECTOR) || row.closest(PROCESS_SELECTOR)) return false;
      const kind = String(row.getAttribute("data-chat-flow-kind") || "").trim();
      // DSH reserves these for timeline mechanics rather than a user/model
      // utterance. Unknown non-process kinds stay eligible so this plugin
      // remains compatible with future DSH message renderers.
      if (kind === "" || kind === "turn-trigger") return false;
      return true;
    }

    function latestMessageSnapshot() {
      const transcript = document.querySelector(TRANSCRIPT_SELECTOR);
      if (!transcript) return null;
      const rows = transcript.querySelectorAll(MESSAGE_SELECTOR);
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index];
        if (!isSubstantiveMessageRow(row)) continue;
        const text = substantiveTextOf(row);
        if (!text) continue;
        return {
          role: messageRole(row),
          text: text.slice(0, MAX_SNAPSHOT_CHARS),
          capturedAt: Date.now(),
        };
      }
      return null;
    }

    function recordCurrentCheckpoint() {
      if (!selectedSessionId) return;
      const snapshot = latestMessageSnapshot();
      if (!snapshot) return;
      const prior = loadSessionState(selectedSessionId) || {};
      const baseline = sessionBaselines.get(selectedSessionId);
      // Merely opening an old transcript must not make it "today active".
      // We first remember the already rendered row in memory. Only a later
      // change in that session is persisted as activity.
      if (!prior.lastMessage && baseline?.text === snapshot.text && baseline?.role === snapshot.role) return;
      if (prior.lastMessage?.text === snapshot.text && prior.lastMessage?.role === snapshot.role) return;
      saveSessionState(selectedSessionId, {
        ...prior,
        lastActiveAt: snapshot.capturedAt,
        lastMessage: snapshot,
      });
    }

    function observeTranscript() {
      observer?.disconnect();
      observer = null;
      const transcript = document.querySelector(TRANSCRIPT_SELECTOR);
      if (!transcript || !selectedSessionId) return;
      observer = new MutationObserver(() => {
        clearTimeout(observationTimer);
        observationTimer = setTimeout(recordCurrentCheckpoint, 550);
      });
      observer.observe(transcript, { childList: true, subtree: true, characterData: true });
    }

    function formatDuration(milliseconds) {
      const totalMinutes = Math.max(1, Math.floor(milliseconds / 60000));
      const days = Math.floor(totalMinutes / 1440);
      const hours = Math.floor((totalMinutes % 1440) / 60);
      const minutes = totalMinutes % 60;
      const parts = [];
      if (days > 0) parts.push(`${days} 天`);
      if (hours > 0) parts.push(`${hours} 小时`);
      if (minutes > 0 || parts.length === 0) parts.push(`${minutes} 分钟`);
      return parts.join(" ");
    }

    function localDayKey(timestamp) {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(new Date(timestamp));
      const value = Object.fromEntries(parts
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]));
      return `${value.year}-${value.month}-${value.day}`;
    }

    function isInWorkingSet(state, config) {
      if (config.scopeMode === "all") return true;
      if (config.scopeMode === "manual") return state?.manualIncluded === true;
      // "Today active" means a substantive message was observed today.
      // Opening a historical transcript by itself never qualifies.
      return Number.isFinite(state?.lastActiveAt) && localDayKey(state.lastActiveAt) === localDayKey(Date.now());
    }

    function scopeLabel(mode) {
      if (mode === "all") return "所有已记录会话";
      if (mode === "manual") return "仅手动加入的会话";
      return "仅今日活跃会话";
    }

    function directPrompt(kind, state) {
      const last = state?.lastMessage;
      const quoted = last ? `\n\n当前对话最近一条${last.role}消息如下：\n「${last.text}」` : "";
      if (kind === "A") {
        return `请把当前对话最近一条消息当作“继续工作的断点”，只复述这条消息已经明确的任务、约束和期待结果。不要声称知道更早的内容，不要读取长期记忆、其他对话、外部文件或项目状态；若某项未在这条消息中出现，请标注“无法从这一条判断”。${quoted}`;
      }
      return `请只根据当前对话最近一条消息，做一个极简断点汇报：这条消息要求做什么、可确认的完成状态、仍无法确认的事项、可直接继续的下一步。不要读取长期记忆、其他对话、外部文件或项目状态；不要把猜测写成事实。${quoted}`;
    }

    function selectedScope(ctx) {
      try {
        const sessions = ctx?.get?.("sessions");
        const sessionId = currentSessionId(ctx);
        if (!sessions || !sessionId) return null;
        if (typeof sessions.binding === "function") return sessions.binding(sessionId)?.ctx || null;
        return sessions.scope?.(sessionId) || null;
      } catch {
        return null;
      }
    }

    async function sendChoice(kind) {
      const state = selectedSessionId ? loadSessionState(selectedSessionId) : null;
      if (kind === "C") {
        closeOverlay();
        focusComposer();
        return;
      }
      if (kind === "D") {
        if (selectedSessionId) {
          const previous = state || {};
          saveSessionState(selectedSessionId, { ...previous, dismissedAt: Date.now() });
        }
        closeOverlay();
        focusComposer();
        return;
      }
      const scope = selectedScope(ctxRef);
      const conversation = scope?.get?.("conversation");
      if (typeof conversation?.send !== "function") {
        showInlineResult("DSH 当前没有暴露可发送的会话接口。本次无法自动发起回顾。");
        return;
      }
      closeOverlay();
      try {
        await conversation.send(directPrompt(kind, state));
      } catch (error) {
        console.warn("[dsh-welcome-back] unable to send return prompt", error);
        showInlineResult("回归请求发送失败。请稍后重试，或直接继续本次对话。");
      }
    }

    function focusComposer() {
      const composer = document.querySelector(
        '[data-composer-input], [data-slot="conversation.composer"] textarea, [data-slot="conversation.composer"] [contenteditable="true"], textarea[data-phase], [data-composer-card] [contenteditable="true"]',
      );
      composer?.focus?.();
    }

    function ensureStyles() {
      const existing = document.getElementById(STYLE_ID);
      if (existing) return;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = `
        .dwb-gear { position: fixed; right: 18px; bottom: 18px; z-index: 2147483000; width: 32px; height: 32px; border: 1px solid var(--dsw-alias-border-l2, #555); border-radius: 50%; background: var(--dsw-alias-bg-layer-2, #292929); color: var(--dsw-alias-label-secondary, #bbb); cursor: pointer; font: 16px/1 system-ui; }
        .dwb-gear:hover { color: var(--dsw-alias-label-primary, #fff); border-color: var(--dsw-alias-label-secondary, #aaa); }
        .dwb-backdrop { position: fixed; inset: 0; z-index: 2147483100; display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, #000 48%, transparent); }
        .dwb-card { width: min(520px, calc(100vw - 32px)); box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l2, #555); border-radius: 14px; background: var(--dsw-alias-bg-layer-1, #202020); color: var(--dsw-alias-label-primary, #f5f5f5); box-shadow: 0 16px 48px #0008; padding: 22px; font: 14px/1.55 var(--dsw-font-family, system-ui); }
        .dwb-card h2 { margin: 0 0 8px; font-size: 18px; }
        .dwb-muted { color: var(--dsw-alias-label-secondary, #aaa); font-size: 12px; }
        .dwb-last { margin: 14px 0; padding: 10px 12px; border-left: 3px solid var(--color-blue-500, #4c9aff); background: var(--dsw-alias-bg-layer-2, #292929); border-radius: 6px; white-space: pre-wrap; overflow-wrap: anywhere; }
        .dwb-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 16px; }
        .dwb-actions button, .dwb-form button { border: 1px solid var(--dsw-alias-border-l2, #555); border-radius: 8px; background: var(--dsw-alias-bg-layer-2, #292929); color: inherit; cursor: pointer; padding: 8px 10px; font: inherit; text-align: left; }
        .dwb-actions button:hover, .dwb-form button:hover { border-color: var(--color-blue-500, #4c9aff); }
        .dwb-actions kbd { float: right; color: var(--dsw-alias-label-secondary, #aaa); font-family: ui-monospace, monospace; }
        .dwb-form { display: grid; gap: 12px; }
        .dwb-form label { display: grid; gap: 5px; }
        .dwb-form input, .dwb-form select { box-sizing: border-box; width: 100%; padding: 7px 9px; border: 1px solid var(--dsw-alias-border-l2, #555); border-radius: 7px; background: var(--dsw-alias-bg-layer-2, #292929); color: inherit; font: inherit; }
        .dwb-form .dwb-check { display: flex; align-items: center; gap: 8px; }
        .dwb-form .dwb-check input { width: auto; }
        .dwb-form .dwb-row { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
        .dwb-result { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 2147483200; max-width: min(600px, calc(100vw - 32px)); padding: 9px 12px; border-radius: 8px; background: var(--dsw-alias-bg-layer-1, #202020); color: var(--dsw-alias-label-primary, #fff); border: 1px solid var(--dsw-alias-border-l2, #555); box-shadow: 0 4px 18px #0006; font: 13px/1.45 system-ui; }
      `;
      document.head?.appendChild(style);
    }

    function closeOverlay() {
      document.getElementById(OVERLAY_ID)?.remove();
      showingForSession = null;
    }

    function showInlineResult(message) {
      document.querySelector(".dwb-result")?.remove();
      const result = document.createElement("div");
      result.className = "dwb-result";
      result.textContent = message;
      document.body.appendChild(result);
      window.setTimeout(() => result.remove(), 4200);
    }

    function showReturnOverlay(sessionId, state, idleMs) {
      closeOverlay();
      showingForSession = sessionId;
      const config = loadConfig();
      const backdrop = document.createElement("div");
      backdrop.id = OVERLAY_ID;
      backdrop.className = "dwb-backdrop";
      backdrop.setAttribute("role", "dialog");
      backdrop.setAttribute("aria-modal", "true");

      const card = document.createElement("section");
      card.className = "dwb-card";
      const title = document.createElement("h2");
      title.textContent = config.greeting;
      const duration = document.createElement("div");
      duration.className = "dwb-muted";
      duration.textContent = config.showDuration ? `这段对话已停顿 ${formatDuration(idleMs)}。` : "这段对话已停顿较长时间。";
      const checkpoint = document.createElement("div");
      checkpoint.className = "dwb-last";
      const message = state.lastMessage;
      checkpoint.textContent = message
        ? `上一条${message.role}消息：\n${message.text}`
        : "未能读取这段对话上一条可见消息。";
      const hint = document.createElement("div");
      hint.className = "dwb-muted";
      hint.textContent = `提醒范围：${scopeLabel(config.scopeMode)}。仅基于本对话的上一条消息，不读取记忆、其他对话或外部内容。`;

      const actions = document.createElement("div");
      actions.className = "dwb-actions";
      const choices = [
        ["A", "帮我回忆上一轮具体说了什么"],
        ["B", "总结上一轮完成与未完成"],
        ["C", "不回顾，直接继续"],
        ["D", "本次不提醒"],
      ];
      for (const [key, label] of choices) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.choice = key;
        button.textContent = label;
        const kbd = document.createElement("kbd");
        kbd.textContent = key;
        button.appendChild(kbd);
        button.addEventListener("click", () => sendChoice(key));
        actions.appendChild(button);
      }
      card.append(title, duration, checkpoint, hint, actions);
      backdrop.appendChild(card);
      document.body.appendChild(backdrop);
    }

    function openSettings() {
      document.getElementById(SETTINGS_ID)?.remove();
      const config = loadConfig();
      const backdrop = document.createElement("div");
      backdrop.id = SETTINGS_ID;
      backdrop.className = "dwb-backdrop";
      backdrop.setAttribute("role", "dialog");
      backdrop.setAttribute("aria-modal", "true");
      const card = document.createElement("section");
      card.className = "dwb-card";
      const title = document.createElement("h2");
      title.textContent = "欢迎回归设置";
      const note = document.createElement("div");
      note.className = "dwb-muted";
      note.textContent = "只在你打开某个会话时检查它；不会扫描或弹出其他会话。今日活跃指今天出现过实质消息，单纯打开旧会话不算。";
      const form = document.createElement("form");
      form.className = "dwb-form";
      form.innerHTML = `
        <label class="dwb-check"><input name="enabled" type="checkbox"> 启用对话回归提醒</label>
        <label>闲置阈值（分钟）<input name="thresholdMinutes" type="number" min="1" step="1"></label>
        <label>最短重复提醒间隔（分钟）<input name="repeatMinutes" type="number" min="1" step="1"></label>
        <label>提醒范围
          <select name="scopeMode">
            <option value="today-active">仅今日活跃会话（推荐）</option>
            <option value="manual">仅手动加入的会话</option>
            <option value="all">所有已记录会话</option>
          </select>
        </label>
        <label class="dwb-check"><input name="showDuration" type="checkbox"> 显示离开时长</label>
        <label>欢迎语<input name="greeting" type="text" maxlength="80"></label>
        <div class="dwb-working-set"></div>
        <div class="dwb-row"><button type="button" data-close>取消</button><button type="submit">保存</button></div>
      `;
      form.elements.enabled.checked = config.enabled;
      form.elements.thresholdMinutes.value = String(config.thresholdMinutes);
      form.elements.repeatMinutes.value = String(config.repeatMinutes);
      form.elements.scopeMode.value = config.scopeMode;
      form.elements.showDuration.checked = config.showDuration;
      form.elements.greeting.value = config.greeting;
      const workingSet = form.querySelector(".dwb-working-set");
      if (selectedSessionId) {
        const state = loadSessionState(selectedSessionId) || {};
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.textContent = state.manualIncluded ? "将当前会话移出手动工作集" : "将当前会话加入手动工作集";
        toggle.addEventListener("click", () => {
          saveSessionState(selectedSessionId, { ...state, manualIncluded: !state.manualIncluded });
          backdrop.remove();
          showInlineResult(state.manualIncluded ? "当前会话已移出手动工作集。" : "当前会话已加入手动工作集。");
        });
        workingSet.appendChild(toggle);
      } else {
        workingSet.textContent = "尚未识别到当前会话，暂不能加入手动工作集。";
      }
      form.querySelector("[data-close]").addEventListener("click", () => backdrop.remove());
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const values = new FormData(form);
        const thresholdMinutes = Math.max(1, Math.floor(Number(values.get("thresholdMinutes")) || DEFAULT_CONFIG.thresholdMinutes));
        const repeatMinutes = Math.max(1, Math.floor(Number(values.get("repeatMinutes")) || DEFAULT_CONFIG.repeatMinutes));
        saveConfig({
          enabled: form.elements.enabled.checked,
          thresholdMinutes,
          repeatMinutes,
          showDuration: form.elements.showDuration.checked,
          greeting: String(values.get("greeting") || "").trim() || DEFAULT_CONFIG.greeting,
          scopeMode: String(values.get("scopeMode") || DEFAULT_CONFIG.scopeMode),
        });
        backdrop.remove();
        showInlineResult("欢迎回归设置已保存。");
      });
      card.append(title, note, form);
      backdrop.appendChild(card);
      document.body.appendChild(backdrop);
    }

    function ensureGear() {
      ensureStyles();
      if (document.getElementById(GEAR_ID)) return;
      const button = document.createElement("button");
      button.id = GEAR_ID;
      button.className = "dwb-gear";
      button.type = "button";
      button.title = "欢迎回归设置";
      button.textContent = "◷";
      button.addEventListener("click", openSettings);
      document.body.appendChild(button);
    }

    function maybeWelcome(sessionId) {
      const config = loadConfig();
      if (!config.enabled || showingForSession === sessionId) return;
      const state = loadSessionState(sessionId);
      if (!state || !Number.isFinite(state.lastActiveAt) || !state.lastMessage?.text) return;
      if (!isInWorkingSet(state, config)) return;
      const now = Date.now();
      const idleMs = now - state.lastActiveAt;
      const thresholdMs = config.thresholdMinutes * 60000;
      const repeatMs = config.repeatMinutes * 60000;
      if (idleMs < thresholdMs) return;
      if (Number.isFinite(state.dismissedAt) && now - state.dismissedAt < repeatMs) return;
      showReturnOverlay(sessionId, state, idleMs);
    }

    function onSessionMaybeChanged() {
      const next = currentSessionId(ctxRef);
      if (next === selectedSessionId) return;
      selectedSessionId = next;
      closeOverlay();
      observeTranscript();
      if (next) {
        // Let DSH render its selected session before reading its final row.
        window.setTimeout(() => {
          const initial = latestMessageSnapshot();
          if (initial) sessionBaselines.set(next, initial);
          observeTranscript();
          maybeWelcome(next);
        }, 450);
      }
    }

    function installKeyboardChoices() {
      document.addEventListener("keydown", (event) => {
        if (!document.getElementById(OVERLAY_ID)) return;
        if (event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
        const key = String(event.key || "").toUpperCase();
        if (!["A", "B", "C", "D", "ESCAPE"].includes(key)) return;
        event.preventDefault();
        event.stopPropagation();
        if (key === "ESCAPE") sendChoice("C");
        else sendChoice(key);
      }, true);
    }

    function apply(ctx) {
      ctxRef = ctx;
      ensureGear();
      installKeyboardChoices();
      onSessionMaybeChanged();
      sessionPollTimer = window.setInterval(onSessionMaybeChanged, SESSION_POLL_MS);
      ctx.effect(() => () => {
        clearInterval(sessionPollTimer);
        clearTimeout(observationTimer);
        observer?.disconnect();
        sessionBaselines.clear();
        document.getElementById(OVERLAY_ID)?.remove();
        document.getElementById(SETTINGS_ID)?.remove();
        document.getElementById(GEAR_ID)?.remove();
      }, "dsh-welcome-back: cleanup");
    }

    exports.apply = apply;
    exports.inject = [];
    return module.exports;
  },
});
