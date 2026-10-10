/* NeX-Agent Web — chat + terminal. Tanpa framework, tanpa build. */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const sessionsEl = $("sessions");
  const messagesEl = $("messages");
  const inputEl = $("input");
  const sendBtn = $("send");
  const stopBtn = $("stop");
  const allowAllEl = $("allow-all");
  const modeBadge = $("mode-badge");
  const connEl = $("conn");
  const terminalEl = $("terminal");
  const backdropEl = $("backdrop");
  const sidebarToggle = $("sidebar-toggle");

  // ---- token ----
  function readToken() {
    const hash = location.hash || "";
    const match = /[#&]t=([^&]+)/.exec(hash);
    if (match) {
      const value = decodeURIComponent(match[1]);
      sessionStorage.setItem("nex.token", value);
      history.replaceState(null, "", location.pathname + location.search);
      return value;
    }
    return sessionStorage.getItem("nex.token") || "";
  }

  const token = readToken();
  if (!token) {
    document.body.innerHTML =
      '<div style="padding:40px;font-family:system-ui;color:#dfe6ef">' +
      "<h2>Akses ditolak</h2><p>Buka URL lengkap yang dicetak oleh <code>nex-agent serve</code> " +
      "(termasuk token <code>#t=…</code>).</p></div>";
    return;
  }

  // ---- util ----
  function escapeHtml(value) {
    return String(value).replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  }

  function inline(value) {
    let t = escapeHtml(value);
    t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
    t = t.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return t;
  }

  function renderMarkdown(src) {
    const lines = String(src).split("\n");
    let html = "";
    let inCode = false;
    let listType = null;
    let codeBuf = [];
    const closeList = () => {
      if (listType) {
        html += "</" + listType + ">";
        listType = null;
      }
    };
    for (const raw of lines) {
      if (inCode) {
        if (/^```/.test(raw)) {
          html += '<pre class="code"><code>' + escapeHtml(codeBuf.join("\n")) + "</code></pre>";
          inCode = false;
          codeBuf = [];
        } else {
          codeBuf.push(raw);
        }
        continue;
      }
      if (/^```\w*\s*$/.test(raw)) {
        closeList();
        inCode = true;
        continue;
      }
      const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
      if (heading) {
        closeList();
        const lvl = heading[1].length;
        html += "<h" + lvl + ">" + inline(heading[2]) + "</h" + lvl + ">";
        continue;
      }
      const ul = /^\s*[-*]\s+(.*)$/.exec(raw);
      if (ul) {
        if (listType !== "ul") {
          closeList();
          html += "<ul>";
          listType = "ul";
        }
        html += "<li>" + inline(ul[1]) + "</li>";
        continue;
      }
      const ol = /^\s*\d+\.\s+(.*)$/.exec(raw);
      if (ol) {
        if (listType !== "ol") {
          closeList();
          html += "<ol>";
          listType = "ol";
        }
        html += "<li>" + inline(ol[1]) + "</li>";
        continue;
      }
      const bq = /^>\s?(.*)$/.exec(raw);
      if (bq) {
        closeList();
        html += "<blockquote>" + inline(bq[1]) + "</blockquote>";
        continue;
      }
      if (raw.trim() === "") {
        closeList();
        html += '<div class="gap"></div>';
        continue;
      }
      closeList();
      html += "<p>" + inline(raw) + "</p>";
    }
    if (inCode) html += '<pre class="code"><code>' + escapeHtml(codeBuf.join("\n")) + "</code></pre>";
    closeList();
    return html;
  }

  function scrollDown() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ---- drawer (mobile) ----
  function openDrawer() {
    document.body.classList.add("drawer-open");
    if (sidebarToggle) sidebarToggle.setAttribute("aria-expanded", "true");
  }

  function closeDrawer() {
    if (!document.body.classList.contains("drawer-open")) return;
    document.body.classList.remove("drawer-open");
    if (sidebarToggle) sidebarToggle.setAttribute("aria-expanded", "false");
  }

  function clearEmpty() {
    const el = messagesEl.querySelector(".empty-state");
    if (el) el.remove();
  }

  function renderEmpty() {
    messagesEl.innerHTML = "";
    const el = document.createElement("div");
    el.className = "empty-state";
    el.innerHTML =
      "<h2>Mulai percakapan</h2><p>Tulis pesan di bawah, atau buka tab " +
      "<strong>Terminal</strong> untuk shell penuh di browser.</p>";
    messagesEl.appendChild(el);
  }

  // ---- state ----
  let ws = null;
  let state = null;
  let currentTurn = null;
  const pendingApprovals = new Map();

  function send(message) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }

  // ---- rendering ----
  function addMessage(kind, label) {
    clearEmpty();
    const wrap = document.createElement("div");
    wrap.className = "msg " + kind;
    if (label) {
      const who = document.createElement("div");
      who.className = "who";
      who.textContent = label;
      wrap.appendChild(who);
    }
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);
    scrollDown();
    return bubble;
  }

  function newTurn() {
    clearEmpty();
    const wrap = document.createElement("div");
    wrap.className = "msg assistant";
    const who = document.createElement("div");
    who.className = "who";
    who.textContent = "assistant";
    wrap.appendChild(who);
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    wrap.appendChild(bubble);
    const todos = document.createElement("div");
    todos.className = "todos live";
    todos.hidden = true;
    bubble.appendChild(todos);
    messagesEl.appendChild(wrap);
    currentTurn = { wrap, bubble, todos, text: "", textEl: null, thinkEl: null, thinkBody: null };
    scrollDown();
    return currentTurn;
  }

  function ensureTurn() {
    return currentTurn || newTurn();
  }

  function appendText(chunk) {
    const turn = ensureTurn();
    if (!turn.textEl) {
      turn.textEl = document.createElement("div");
      turn.bubble.appendChild(turn.textEl);
    }
    turn.text += chunk;
    turn.textEl.innerHTML = renderMarkdown(turn.text);
    scrollDown();
  }

  function appendThinking(chunk) {
    const turn = ensureTurn();
    if (!turn.thinkEl) {
      const details = document.createElement("details");
      details.className = "think";
      details.open = false;
      const summary = document.createElement("summary");
      summary.textContent = "thinking…";
      const body = document.createElement("div");
      body.className = "body";
      details.appendChild(summary);
      details.appendChild(body);
      turn.bubble.insertBefore(details, turn.bubble.firstChild);
      turn.thinkEl = details;
      turn.thinkBody = body;
    }
    turn.thinkBody.textContent += chunk;
    scrollDown();
  }

  function addStep(info) {
    const turn = ensureTurn();
    const el = document.createElement("div");
    el.className = "step";
    el.innerHTML =
      '<span class="name">' +
      escapeHtml(info.name) +
      '</span><span class="risk">[' +
      escapeHtml(info.risk) +
      ']</span><span class="args">' +
      escapeHtml(info.argsSummary || "") +
      "</span>";
    turn.bubble.appendChild(el);
    scrollDown();
  }

  function endStep(outcome) {
    if (!currentTurn) return;
    const steps = currentTurn.bubble.querySelectorAll(".step");
    const el = steps[steps.length - 1];
    if (!el) return;
    const res = document.createElement("span");
    res.className = "result " + outcome.status;
    res.textContent = "→ " + outcome.status + (outcome.durationMs ? " " + outcome.durationMs + "ms" : "");
    el.appendChild(res);
  }

  function addDiff(text) {
    const turn = ensureTurn();
    const pre = document.createElement("div");
    pre.className = "diffblock";
    pre.textContent = String(text || "");
    turn.bubble.appendChild(pre);
    scrollDown();
  }

  function addNotice(kind, message) {
    const bubble = addMessage("system " + kind, kind === "info" ? null : kind);
    bubble.textContent = message;
  }

  function renderTodos(items) {
    const turn = ensureTurn();
    const box = turn.todos;
    if (!items || items.length === 0) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    box.innerHTML =
      '<div class="th">tugas (' +
      items.filter((t) => t.status === "completed").length +
      "/" +
      items.length +
      ")</div>" +
      items
        .map((t) => {
          const mark = t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[>]" : "[ ]";
          const cls = t.status === "completed" ? "done" : t.status === "in_progress" ? "active" : "";
          return (
            '<div class="todo ' +
            cls +
            '"><span class="mark">' +
            mark +
            '</span><span class="txt">' +
            escapeHtml(t.content || "") +
            "</span></div>"
          );
        })
        .join("");
    scrollDown();
  }

  function showApproval(message) {
    const isConfirm = message.type === "confirm";
    const req = message.request;
    const id = message.id;
    const turn = ensureTurn();
    const box = document.createElement("div");
    box.className = "approval " + (message.type === "sensitiveAccess" ? "sensitive" : "");
    box.dataset.approval = id;
    const title = isConfirm
      ? req.title
      : message.type === "sensitiveAccess"
        ? "Akses file sensitif"
        : "Akses di luar workspace";
    box.innerHTML =
      '<div class="ttl">' +
      escapeHtml(title) +
      '</div><div class="det">' +
      escapeHtml(req.detail || req.path || "") +
      "</div>" +
      (req.diff ? '<div class="diffblock">' + escapeHtml(req.diff) + "</div>" : "") +
      '<div class="actions"></div>';
    const actions = box.querySelector(".actions");

    const resolve = (value) => {
      if (isConfirm) send({ type: "approval.resolve", id, decision: value });
      else if (message.type === "sensitiveAccess") send({ type: "sensitive.resolve", id, allow: value });
      else send({ type: "path.resolve", id, allow: value });
      box.querySelectorAll("button").forEach((b) => (b.disabled = true));
      const verdict = value === "no" || value === false ? " — ditolak" : " — disetujui";
      box.querySelector(".ttl").textContent += verdict;
      pendingApprovals.delete(id);
    };

    const addButton = (label, cls, value) => {
      const b = document.createElement("button");
      if (cls) b.className = cls;
      b.textContent = label;
      b.addEventListener("click", () => resolve(value));
      actions.appendChild(b);
    };

    if (isConfirm) {
      addButton("Ya", "yes", "yes");
      addButton("Tidak", "no", "no");
      addButton("Selalu (sesi)", "", "all");
    } else {
      addButton("Izinkan", "yes", true);
      addButton("Tolak", "no", false);
    }
    turn.bubble.appendChild(box);
    pendingApprovals.set(id, box);
    scrollDown();
  }

  // ---- sidebar & state ----
  function renderSessions(items) {
    sessionsEl.innerHTML = "";
    const activeId = state && state.current ? state.current.id : null;
    for (const s of items) {
      const row = document.createElement("div");
      row.className = "session" + (s.id === activeId ? " active" : "");
      const title = document.createElement("span");
      title.className = "title";
      title.textContent = s.title || "(baru)";
      title.title = s.workspace || "";
      const when = document.createElement("span");
      when.className = "when";
      when.textContent = (s.updatedAt || "").slice(5, 16).replace("T", " ");
      const del = document.createElement("button");
      del.className = "del";
      del.title = "Hapus sesi";
      del.textContent = "✕";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        if (confirm("Hapus sesi ini?")) send({ type: "session.delete", id: s.id });
      });
      row.appendChild(title);
      row.appendChild(when);
      row.appendChild(del);
      row.addEventListener("click", () => {
        send({ type: "session.open", id: s.id });
        closeDrawer();
      });
      sessionsEl.appendChild(row);
    }
  }

  function applyState(next) {
    state = next;
    modeBadge.textContent = next.mode;
    modeBadge.className = "badge " + next.mode;
    allowAllEl.checked = Boolean(next.allowAll);
    renderSessions(next.sessions || []);
    document.title = "NeX-Agent — " + (next.current ? next.current.title : "web");
  }

  function renderHistory(history) {
    messagesEl.innerHTML = "";
    const items = history || [];
    if (!items.length) {
      renderEmpty();
      return;
    }
    for (const m of items) {
      if (m.role === "user") addMessage("user", "kamu").textContent = m.content;
      else if (m.role === "assistant" && m.content) addMessage("assistant", "assistant").innerHTML = renderMarkdown(m.content);
    }
    scrollDown();
  }

  function setBusy(on) {
    sendBtn.disabled = on;
    inputEl.disabled = on;
    stopBtn.hidden = !on;
    if (on) inputEl.blur();
    else inputEl.focus();
  }

  // ---- websocket ----
  function handle(msg) {
    switch (msg.type) {
      case "ready":
      case "state":
        applyState(msg.state);
        break;
      case "sessions":
        if (state) {
          state.sessions = msg.items;
          renderSessions(msg.items);
        }
        break;
      case "session":
        currentTurn = null;
        renderHistory(msg.history || []);
        if (state) {
          state.current = msg.summary;
          state.sessions = state.sessions.map((s) => (s.id === msg.summary.id ? msg.summary : s));
          if (!state.sessions.some((s) => s.id === msg.summary.id)) state.sessions.unshift(msg.summary);
          renderSessions(state.sessions);
        }
        break;
      case "text":
        appendText(msg.chunk);
        break;
      case "thinking":
        appendThinking(msg.chunk);
        break;
      case "thinkingEnd":
        if (currentTurn && currentTurn.thinkEl) currentTurn.thinkEl.querySelector("summary").textContent = "thinking";
        break;
      case "stepStart":
        addStep(msg.info);
        break;
      case "stepEnd":
        endStep(msg.outcome);
        break;
      case "diff":
        addDiff(msg.text);
        break;
      case "todos":
        renderTodos(msg.items || []);
        break;
      case "info":
        addNotice("info", msg.message);
        break;
      case "warn":
        addNotice("warn", msg.message);
        break;
      case "error":
        addNotice("error", msg.message);
        break;
      case "summary":
        addNotice("warn", msg.message);
        break;
      case "mode":
        if (state) {
          state.mode = msg.mode;
          modeBadge.textContent = msg.mode;
          modeBadge.className = "badge " + msg.mode;
        }
        break;
      case "busy":
        setBusy(msg.on);
        break;
      case "confirm":
      case "pathAccess":
      case "sensitiveAccess":
        showApproval(msg);
        break;
      case "terminal.data":
        writeTerminal(msg.id, msg.data);
        break;
      case "terminal.exit":
        writeTerminal(msg.id, "\r\n[proses berakhir" + (msg.code === null ? "" : " (" + msg.code + ")") + "]\r\n");
        break;
      case "fatal":
        addNotice("error", msg.message);
        break;
      default:
        break;
    }
  }

  function connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(proto + "//" + location.host + "/ws?token=" + encodeURIComponent(token));
    ws.addEventListener("open", () => {
      connEl.textContent = "terhubung";
      connEl.className = "conn ok";
    });
    ws.addEventListener("close", () => {
      connEl.textContent = "terputus — menyambung ulang…";
      connEl.className = "conn bad";
      setBusy(false);
      setTimeout(connect, 1500);
    });
    ws.addEventListener("error", () => {
      connEl.textContent = "error koneksi";
      connEl.className = "conn bad";
    });
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      handle(msg);
    });
  }

  // ---- terminal ----
  let term = null;
  let fit = null;
  let terminalId = localStorage.getItem("nex.termId");
  if (!terminalId) {
    terminalId = "term_" + Math.random().toString(36).slice(2, 10);
    localStorage.setItem("nex.termId", terminalId);
  }
  const pendingTerm = [];

  function writeTerminal(id, data) {
    if (term && id === terminalId) term.write(data);
    else pendingTerm.push([id, data]);
  }

  function refit() {
    if (!term || !fit) return;
    try {
      fit.fit();
      send({ type: "terminal.resize", id: terminalId, cols: term.cols, rows: term.rows });
    } catch {
      /* abaikan */
    }
  }

  function ensureTerminal() {
    if (term) {
      try {
        fit && fit.fit();
      } catch {
        /* abaikan */
      }
      return;
    }
    if (typeof Terminal === "undefined") {
      terminalEl.textContent = "xterm.js tidak termuat.";
      return;
    }
    term = new Terminal({
      fontFamily: '"JetBrains Mono", Menlo, Consolas, monospace',
      fontSize: window.innerWidth < 480 ? 12 : 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: { background: "#0b0f14", foreground: "#dfe6ef", cursor: "#4f9cf9" },
    });
    const FitCtor = window.FitAddon && window.FitAddon.FitAddon ? window.FitAddon.FitAddon : window.FitAddon;
    if (FitCtor) {
      fit = new FitCtor();
      term.loadAddon(fit);
    }
    term.open(terminalEl);
    term.onData((data) => send({ type: "terminal.input", id: terminalId, data }));
    send({ type: "terminal.open", id: terminalId, cols: term.cols, rows: term.rows });
    for (const entry of pendingTerm.splice(0)) {
      if (entry[0] === terminalId) term.write(entry[1]);
    }
    window.addEventListener("resize", refit);
    if (window.visualViewport) window.visualViewport.addEventListener("resize", refit);
  }

  // ---- tabs & events ----
  function setTab(name) {
    document.querySelectorAll(".tab").forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
    });
    $("view-chat").hidden = name !== "chat";
    $("view-terminal").hidden = name !== "terminal";
    closeDrawer();
    if (name === "terminal") {
      ensureTerminal();
      setTimeout(refit, 40);
    }
  }

  function submit() {
    const text = inputEl.value.trim();
    if (!text) return;
    addMessage("user", "kamu").textContent = text;
    currentTurn = null;
    send({ type: "chat.send", text });
    inputEl.value = "";
    inputEl.style.height = "auto";
  }

  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => setTab(t.dataset.tab)));
  $("new-session").addEventListener("click", () => {
    send({ type: "session.new" });
    closeDrawer();
  });
  if (sidebarToggle) sidebarToggle.addEventListener("click", openDrawer);
  if (backdropEl) backdropEl.addEventListener("click", closeDrawer);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDrawer();
  });
  window.addEventListener("resize", () => {
    if (window.innerWidth > 820) closeDrawer();
  });
  allowAllEl.addEventListener("change", () => send({ type: "allowAll.set", on: allowAllEl.checked }));
  function toggleMode() {
    send({ type: "mode.set", mode: state && state.mode === "plan" ? "build" : "plan" });
  }
  modeBadge.style.cursor = "pointer";
  modeBadge.title = "Klik untuk ganti mode";
  modeBadge.addEventListener("click", toggleMode);
  modeBadge.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleMode();
    }
  });
  sendBtn.addEventListener("click", submit);
  stopBtn.addEventListener("click", () => send({ type: "chat.interrupt" }));
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });
  inputEl.addEventListener("input", () => {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + "px";
  });

  renderEmpty();
  connect();
})();
