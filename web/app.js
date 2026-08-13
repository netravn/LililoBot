const state = {
  token: sessionStorage.getItem("qq-agent-token") || "",
  logs: [],
  eventSource: null,
  chatSessionId: localStorage.getItem("qq-agent-chat-session") || createSessionId(),
  chatMessages: [],
  chatBusy: false,
  observationView: null,
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
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.message || body.error || `请求失败 HTTP ${response.status}`);
    error.status = response.status;
    error.code = body.error;
    throw error;
  }
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
  const listening = status.onebot.listening;
  const healthyAccounts = status.onebot.accounts?.filter((account) => account.healthy) ??
    status.onebot.connectedAccounts.map((selfId) => ({ selfId, healthy: true }));
  const online = listening && healthyAccounts.length > 0;
  text("#onebot-state", online ? "QQ 在线" : listening ? "等待连接" : "已停止");
  text("#onebot-endpoint", `${status.onebot.host}:${status.onebot.port}${status.onebot.path}`);
  text("#account-count", healthyAccounts.length);
  text("#account-list", healthyAccounts.map((account) => account.selfId).join("、") || "尚未连接");
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
  health.querySelector("b").textContent = online ? "QQ 在线" : listening ? "等待 NapCat" : "服务异常";

  const chips = $("#account-chips");
  chips.innerHTML = healthyAccounts.length
    ? healthyAccounts.map((account) => {
      const lastSeen = account.lastHeartbeatAt || account.lastActivityAt;
      const title = lastSeen ? `最后活动：${new Date(lastSeen).toLocaleString()}` : "连接正常";
      return `<span class="account-chip" title="${escapeHtml(title)}">QQ ${escapeHtml(account.selfId)}</span>`;
    }).join("")
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
  fillModelSettings(config.llm);
  const blocks = [
    ["OneBot", [["监听", `${config.onebot.host}:${config.onebot.port}${config.onebot.path}`], ["Token", config.onebot.accessTokenConfigured ? "已配置" : "未配置"]]],
    ["QQ 策略", [["管理员", config.qq.adminUsers.join(", ") || "无"], ["私聊白名单", config.qq.privateAllowlist.join(", ") || "全部"], ["群白名单", config.qq.allowedGroups.join(", ") || "无"], ["触发词", config.qq.groupKeywords.join(", ") || "无"]]],
  ];
  $("#config-grid").innerHTML = blocks
    .map(([title, rows]) => `<article class="config-block"><h3>${title}</h3>${configRows(rows)}</article>`)
    .join("");
}

function observationPayload() {
  return {
    enabled: $("#observation-enabled").checked,
    allGroups: $("#observation-all-groups").checked,
    groups: $("#observation-groups").value.split(/[\s,，]+/).filter(Boolean),
    analysisIntervalMinutes: Number($("#observation-interval").value),
    retentionDays: Number($("#observation-retention").value),
    minMessages: Number($("#observation-min-messages").value),
    maxMessagesPerAnalysis: Number($("#observation-max-messages").value),
  };
}

function fillObservationSettings(settings) {
  $("#observation-enabled").checked = settings.enabled;
  $("#observation-all-groups").checked = settings.allGroups;
  $("#observation-groups").value = settings.groups.join(", ");
  $("#observation-groups").disabled = settings.allGroups;
  $("#observation-interval").value = settings.analysisIntervalMinutes;
  $("#observation-retention").value = settings.retentionDays;
  $("#observation-min-messages").value = settings.minMessages;
  $("#observation-max-messages").value = settings.maxMessagesPerAnalysis;
}

function renderObservation(status, settings = null) {
  if (settings) fillObservationSettings(settings);
  const tag = $("#observation-state");
  tag.textContent = status.enabled ? (status.analysisRunning ? "分析中" : "观察中") : "已关闭";
  tag.className = `tag ${status.enabled ? "" : "neutral"}`;
  const next = status.nextAnalysisAt ? new Date(status.nextAnalysisAt).toLocaleString() : "已暂停";
  const statusNode = $("#observation-settings-status");
  statusNode.textContent = `下次自动分析：${next}`;
  statusNode.className = "settings-status";
  const rows = $("#observation-rows");
  if (!status.groups.length) {
    rows.innerHTML = '<tr><td colspan="5" class="empty-state">尚未收到符合范围的群消息</td></tr>';
    return;
  }
  rows.innerHTML = status.groups.map((group) => `<tr>
    <td><div class="session-key">群 ${escapeHtml(group.groupId)}</div></td>
    <td>${group.messageCount}</td>
    <td>${group.lastMessageAt ? new Date(group.lastMessageAt).toLocaleString() : "—"}</td>
    <td>${group.lastSummaryAt ? new Date(group.lastSummaryAt).toLocaleString() : "尚未分析"}</td>
    <td><div class="row-actions"><button class="small-button" data-observation-messages="${group.groupId}">消息</button><button class="small-button" data-observation-summaries="${group.groupId}">摘要</button><button class="small-button" data-observation-run="${group.groupId}">分析</button></div></td>
  </tr>`).join("");
}

function fillModelSettings(llm) {
  $("#model-base-url-input").value = llm.baseUrl;
  $("#model-id-input").value = llm.model;
  $("#model-temperature-input").value = llm.temperature;
  $("#model-timeout-input").value = llm.timeoutMs;
  $("#model-api-key-input").value = "";
  $("#model-api-key-input").placeholder = llm.apiKeyConfigured ? "留空则保留当前 Key" : "输入 API Key";
  $("#clear-model-api-key").checked = false;
  const managed = llm.managedByEnvironment || {};
  $("#model-base-url-input").disabled = Boolean(managed.baseUrl);
  $("#model-id-input").disabled = Boolean(managed.model);
  $("#model-api-key-input").disabled = Boolean(managed.apiKey);
  $("#clear-model-api-key").disabled = Boolean(managed.apiKey);
  $("#base-url-help").textContent = managed.baseUrl ? "由 OPENAI_BASE_URL 环境变量控制" : "OpenAI Chat Completions 兼容地址";
  $("#api-key-help").textContent = managed.apiKey
    ? "由 OPENAI_API_KEY 环境变量控制"
    : llm.apiKeyConfigured ? "已配置；当前 Key 不会回显" : "尚未配置";
}

function modelSettingsPayload() {
  return {
    baseUrl: $("#model-base-url-input").value.trim(),
    model: $("#model-id-input").value.trim(),
    apiKey: $("#model-api-key-input").value,
    clearApiKey: $("#clear-model-api-key").checked,
    temperature: Number($("#model-temperature-input").value),
    timeoutMs: Number($("#model-timeout-input").value),
  };
}

function setModelSettingsBusy(busy, status = "") {
  $("#test-model-settings").disabled = busy;
  $("#save-model-settings").disabled = busy;
  if (status) {
    const node = $("#model-settings-status");
    node.textContent = status;
    node.className = "settings-status";
  }
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
  state.eventSource.addEventListener("observation", scheduleObservationRefresh);
}

function scheduleObservationRefresh() {
  clearTimeout(scheduleObservationRefresh.timer);
  scheduleObservationRefresh.timer = setTimeout(async () => {
    try {
      renderObservation(await api("/api/observation"));
      if (state.observationView?.type === "messages" && $("#observation-dialog").open) {
        await loadObservationDialog("messages", state.observationView.groupId, false);
      }
    } catch (error) { showToast(error.message); }
  }, 150);
}

async function loadDashboard() {
  try {
    const [status, config, sessions, logs, observation] = await Promise.all([
      api("/api/status"), api("/api/config"), api("/api/sessions"), api("/api/logs?limit=150"), api("/api/observation"),
    ]);
    renderStatus(status);
    renderConfig(config);
    renderSessions(sessions.sessions);
    renderObservation(observation, config.observation);
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
    const [status, sessions, observation] = await Promise.all([api("/api/status"), api("/api/sessions"), api("/api/observation")]);
    renderStatus(status);
    renderSessions(sessions.sessions);
    renderObservation(observation);
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
$("#close-observation-dialog").addEventListener("click", () => {
  state.observationView = null;
  $("#observation-dialog").close();
});
$("#observation-all-groups").addEventListener("change", (event) => {
  $("#observation-groups").disabled = event.target.checked;
});

$("#observation-settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = $("#observation-settings-status");
  status.textContent = "正在保存…";
  try {
    await api("/api/observation-settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(observationPayload()),
    });
    const [config, observation] = await Promise.all([api("/api/config"), api("/api/observation")]);
    renderObservation(observation, config.observation);
    showToast("观察设置已保存并立即生效");
  } catch (error) {
    status.textContent = `保存失败：${error.message}`;
    status.className = "settings-status error";
  }
});

async function runObservation(groupId = null) {
  const status = $("#observation-settings-status");
  status.textContent = groupId ? `正在分析群 ${groupId}…` : "正在分析全部已记录群…";
  try {
    const result = await api("/api/observation/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ groupId, force: true }),
    });
    const completed = result.results.filter((item) => item.status === "completed").length;
    showToast(`分析完成，生成 ${completed} 份摘要`);
    await refreshLiveData();
  } catch (error) {
    status.textContent = `分析失败：${error.message}`;
    status.className = "settings-status error";
  }
}

$("#run-observation").addEventListener("click", () => runObservation());

async function loadObservationDialog(type, groupId, show = true) {
  state.observationView = { type, groupId };
  if (type === "messages") {
    const data = await api(`/api/observation/groups/${groupId}/messages?limit=200`);
    text("#observation-dialog-title", `群 ${groupId} · 最近消息`);
    $("#observation-content").innerHTML = data.messages.length
      ? data.messages.map((message) => `<article class="observed-message"><span>${new Date(message.timestamp).toLocaleString()} · ${escapeHtml(message.senderName)}</span>${escapeHtml(message.content)}</article>`).join("")
      : '<p class="empty-state">这个群还没有保存的消息</p>';
  } else {
    const data = await api(`/api/observation/groups/${groupId}/summaries?limit=20`);
    text("#observation-dialog-title", `群 ${groupId} · 分析摘要`);
    $("#observation-content").innerHTML = data.summaries.length
      ? data.summaries.map((summary) => `<article class="digest"><span>${new Date(summary.createdAt).toLocaleString()} · ${summary.messageCount} 条消息</span>${escapeHtml(summary.summary)}</article>`).join("")
      : '<p class="empty-state">这个群还没有分析摘要</p>';
  }
  if (show) $("#observation-dialog").showModal();
  $("#observation-content").scrollTop = $("#observation-content").scrollHeight;
}

$("#observation-rows").addEventListener("click", async (event) => {
  const runId = event.target.dataset.observationRun;
  const messagesId = event.target.dataset.observationMessages;
  const summariesId = event.target.dataset.observationSummaries;
  if (runId) await runObservation(runId);
  try {
    if (messagesId) await loadObservationDialog("messages", messagesId);
    if (summariesId) await loadObservationDialog("summaries", summariesId);
  } catch (error) { showToast(error.message); }
});

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

$("#test-model-settings").addEventListener("click", async () => {
  if (!$("#model-settings-form").reportValidity()) return;
  setModelSettingsBusy(true, "正在连接模型服务…");
  const status = $("#model-settings-status");
  try {
    const result = await api("/api/model-settings/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(modelSettingsPayload()),
    });
    status.textContent = `连接成功 · ${result.model}`;
    status.className = "settings-status success";
  } catch (error) {
    status.textContent = `连接失败：${error.message}`;
    status.className = "settings-status error";
  } finally {
    setModelSettingsBusy(false);
  }
});

$("#model-settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setModelSettingsBusy(true, "正在保存并应用…");
  const status = $("#model-settings-status");
  try {
    await api("/api/model-settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(modelSettingsPayload()),
    });
    const config = await api("/api/config");
    renderConfig(config);
    status.textContent = "已保存并立即生效";
    status.className = "settings-status success";
    await refreshLiveData();
  } catch (error) {
    status.textContent = `保存失败：${error.message}`;
    status.className = "settings-status error";
  } finally {
    setModelSettingsBusy(false);
  }
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
