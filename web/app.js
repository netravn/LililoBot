const state = {
  token: sessionStorage.getItem("qq-agent-token") || "",
  logs: [],
  eventSource: null,
  chatSessionId: localStorage.getItem("qq-agent-chat-session") || createSessionId(),
  chatMessages: [],
  chatBusy: false,
};

localStorage.setItem("qq-agent-chat-session", state.chatSessionId);

const $ = (selector) => document.querySelector(selector);

async function api(path, options = {}) {
  const headers = new Headers(options.headers);
  if (state.token) headers.set("authorization", `Bearer ${state.token}`);
  const response = await fetch(path, { ...options, headers });
  if (response.status === 401) {
    $("#auth-panel").classList.remove("hidden");
    throw new Error("控制台访问令牌无效");
  }
  if (!response.ok) throw new Error(`请求失败 HTTP ${response.status}`);
  $("#auth-panel").classList.add("hidden");
  return response.json();
}

function text(selector, value) {
  $(selector).textContent = value;
}

function escapeHtml(value) {
  const node = document.createElement("span");
  node.textContent = String(value ?? "");
  return node.innerHTML;
}

function createSessionId() {
  return `web-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function duration(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}天 ${hours}小时`;
  if (hours) return `${hours}小时 ${minutes}分`;
  return `${minutes}分 ${seconds % 60}秒`;
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2400);
}

function renderStatus(status) {
  const online = status.onebot.listening;
  text("#onebot-state", online ? "监听中" : "已停止");
  text("#onebot-endpoint", `${status.onebot.host}:${status.onebot.port}${status.onebot.path}`);
  text("#account-count", status.onebot.connectedAccounts.length);
  text("#account-list", status.onebot.connectedAccounts.join("、") || "尚未连接");
  text("#session-count", status.sessions);
  text("#uptime", duration(status.uptimeSeconds));
  text("#node-version", status.nodeVersion);
  text("#model-name", status.llm.model);
  const modelTag = $("#model-configured");
  modelTag.textContent = status.llm.configured ? "密钥已配置" : "缺少密钥";
  modelTag.classList.toggle("warning", !status.llm.configured);

  const health = $("#health-pill");
  health.classList.toggle("online", online);
  health.classList.toggle("offline", !online);
  health.querySelector("b").textContent = online ? "服务正常" : "服务异常";

  const chips = $("#account-chips");
  chips.innerHTML = status.onebot.connectedAccounts.length
    ? status.onebot.connectedAccounts.map((id) => `<span class="account-chip">QQ ${escapeHtml(id)}</span>`).join("")
    : '<span class="empty-chip">暂无在线账号</span>';
}

function sessionParts(key) {
  const parts = key.split(":");
  if (parts[0] === "onebot") {
    return { platform: "onebot", account: parts[1] || "—", kind: parts[2] || "unknown", conversation: parts[3] || "—" };
  }
  if (parts[0] === "local") {
    return { platform: "local", account: "本地", kind: parts[1] || "local", conversation: parts.slice(2).join(":") || "—" };
  }
  return { platform: parts[0] || "unknown", account: "—", kind: "unknown", conversation: key };
}

function renderSessions(sessions) {
  text("#sessions-updated", `${new Date().toLocaleTimeString()} 更新`);
  const body = $("#session-rows");
  if (!sessions.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty-state">还没有持久化会话</td></tr>';
    return;
  }
  body.innerHTML = sessions
    .map((session) => {
      const parts = sessionParts(session.key);
      const label = parts.platform === "local"
        ? `${parts.kind === "web" ? "网页" : "终端"} ${parts.conversation}`
        : parts.kind === "group" ? `群 ${parts.conversation}` : `用户 ${parts.conversation}`;
      return `<tr>
        <td><span class="scope">${escapeHtml(parts.kind)}</span></td>
        <td><div class="session-key">${escapeHtml(label)}</div><small class="muted">Bot ${escapeHtml(parts.account)}</small></td>
        <td>${session.messageCount}</td>
        <td>${new Date(session.updatedAt).toLocaleString()}</td>
        <td><div class="row-actions"><button class="small-button" data-view="${session.id}">查看</button><button class="small-button danger" data-delete="${session.id}">重置</button></div></td>
      </tr>`;
    })
    .join("");
}

function renderChat() {
  text("#chat-session-label", `网页独立会话 · ${state.chatSessionId}`);
  const container = $("#chat-messages");
  if (!state.chatMessages.length) {
    container.innerHTML = '<div class="chat-empty"><strong>本地对话已经准备好</strong><span>这里的上下文不会进入 QQ 私聊或群聊。</span></div>';
    return;
  }
  container.innerHTML = state.chatMessages
    .map((message) => `<article class="chat-bubble ${message.role}${message.pending ? " pending" : ""}">${escapeHtml(message.content)}</article>`)
    .join("");
  container.scrollTop = container.scrollHeight;
}

async function loadChat() {
  const data = await api(`/api/chat/web/${encodeURIComponent(state.chatSessionId)}`);
  state.chatMessages = data.messages;
  renderChat();
}

function setChatBusy(busy) {
  state.chatBusy = busy;
  $("#chat-input").disabled = busy;
  $("#send-chat").disabled = busy;
  $("#send-chat").textContent = busy ? "思考中" : "发送";
}

async function sendChat(message) {
  if (state.chatBusy) return;
  state.chatMessages.push({ role: "user", content: message });
  state.chatMessages.push({ role: "assistant", content: "莉莉洛正在组织语言", pending: true });
  renderChat();
  setChatBusy(true);
  try {
    const data = await api("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "web", sessionId: state.chatSessionId, message }),
    });
    state.chatMessages[state.chatMessages.length - 1] = { role: "assistant", content: data.answer };
    renderChat();
    await refreshLiveData();
  } catch (error) {
    state.chatMessages.pop();
    state.chatMessages.push({ role: "assistant", content: `消息发送失败：${error.message}` });
    renderChat();
  } finally {
    setChatBusy(false);
    $("#chat-input").focus();
  }
}

function configRows(rows) {
  return rows
    .map(([label, value]) => `<div class="config-row"><span>${escapeHtml(label)}</span><span>${escapeHtml(value)}</span></div>`)
    .join("");
}

function renderConfig(config) {
  text("#bot-name", config.bot.name);
  text("#model-base-url", config.llm.baseUrl);
  const blocks = [
    ["OneBot", [["监听", `${config.onebot.host}:${config.onebot.port}${config.onebot.path}`], ["Token", config.onebot.accessTokenConfigured ? "已配置" : "未配置"]]],
    ["QQ 策略", [["管理员", config.qq.adminUsers.join(", ") || "无"], ["私聊白名单", config.qq.privateAllowlist.join(", ") || "全部"], ["群白名单", config.qq.allowedGroups.join(", ") || "无"], ["触发词", config.qq.groupKeywords.join(", ") || "无"]]],
    ["模型", [["模型", config.llm.model], ["Temperature", config.llm.temperature], ["API Key", config.llm.apiKeyConfigured ? "已配置" : "未配置"], ["超时", `${config.llm.timeoutMs} ms`]]],
  ];
  $("#config-grid").innerHTML = blocks
    .map(([title, rows]) => `<article class="config-block"><h3>${title}</h3>${configRows(rows)}</article>`)
    .join("");
}

function renderLogs() {
  const level = $("#log-level").value;
  const entries = level === "all" ? state.logs : state.logs.filter((entry) => entry.level === level);
  $("#log-stream").innerHTML = entries
    .map((entry) => `<div class="log-line ${entry.level}"><time>${new Date(entry.timestamp).toLocaleTimeString()}</time><span class="log-level">${escapeHtml(entry.level)}</span><span class="log-scope">${escapeHtml(entry.scope)}</span><span class="log-message">${escapeHtml(entry.message)}</span></div>`)
    .join("");
  $("#log-stream").scrollTop = $("#log-stream").scrollHeight;
}

function pushLog(entry) {
  if (state.logs.some((item) => item.id === entry.id)) return;
  state.logs.push(entry);
  if (state.logs.length > 500) state.logs.shift();
  renderLogs();
}

function connectEvents() {
  state.eventSource?.close();
  const query = state.token ? `?token=${encodeURIComponent(state.token)}` : "";
  state.eventSource = new EventSource(`/api/events${query}`);
  state.eventSource.addEventListener("log", (event) => pushLog(JSON.parse(event.data)));
}

async function loadDashboard() {
  try {
    const [status, config, sessions, logs] = await Promise.all([
      api("/api/status"), api("/api/config"), api("/api/sessions"), api("/api/logs?limit=150"),
    ]);
    renderStatus(status);
    renderConfig(config);
    renderSessions(sessions.sessions);
    state.logs = logs.entries;
    renderLogs();
    connectEvents();
    await loadChat();
  } catch (error) {
    showToast(error.message);
  }
}

async function refreshLiveData() {
  try {
    const [status, sessions] = await Promise.all([api("/api/status"), api("/api/sessions")]);
    renderStatus(status);
    renderSessions(sessions.sessions);
  } catch (error) {
    showToast(error.message);
  }
}

$("#auth-form").addEventListener("submit", (event) => {
  event.preventDefault();
  state.token = $("#token-input").value.trim();
  sessionStorage.setItem("qq-agent-token", state.token);
  loadDashboard();
});

$("#refresh-button").addEventListener("click", () => refreshLiveData().then(() => showToast("状态已刷新")));
$("#log-level").addEventListener("change", renderLogs);
$("#clear-logs").addEventListener("click", () => { state.logs = []; renderLogs(); });
$("#close-dialog").addEventListener("click", () => $("#session-dialog").close());

$("#chat-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("#chat-input");
  const message = input.value.trim();
  if (!message) return;
  input.value = "";
  input.style.height = "auto";
  sendChat(message);
});

$("#chat-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("#chat-form").requestSubmit();
  }
});

$("#chat-input").addEventListener("input", (event) => {
  event.target.style.height = "auto";
  event.target.style.height = `${Math.min(event.target.scrollHeight, 150)}px`;
});

$("#new-chat").addEventListener("click", () => {
  state.chatSessionId = createSessionId();
  localStorage.setItem("qq-agent-chat-session", state.chatSessionId);
  state.chatMessages = [];
  renderChat();
  $("#chat-input").focus();
  showToast("已创建新的网页会话");
});

$("#session-rows").addEventListener("click", async (event) => {
  const viewId = event.target.dataset.view;
  const deleteId = event.target.dataset.delete;
  if (viewId) {
    try {
      const session = await api(`/api/sessions/${viewId}`);
      text("#dialog-title", sessionParts(session.key).conversation);
      $("#conversation").innerHTML = session.messages.length
        ? session.messages.map((message) => `<article class="message ${message.role}"><span class="message-role">${escapeHtml(message.role)}</span>${escapeHtml(message.content)}</article>`).join("")
        : '<p class="empty-state">会话中没有消息</p>';
      $("#session-dialog").showModal();
    } catch (error) { showToast(error.message); }
  }
  if (deleteId && confirm("确定重置这个会话吗？历史记录将被删除。")) {
    try {
      await api(`/api/sessions/${deleteId}`, { method: "DELETE" });
      showToast("会话已重置");
      await refreshLiveData();
    } catch (error) { showToast(error.message); }
  }
});

loadDashboard();
setInterval(refreshLiveData, 10000);
