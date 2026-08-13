import fs from "node:fs";
import path from "node:path";

function requiredObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`config.${name} must be an object`);
  }
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function normalizeIdList(value, name) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return [...new Set(value.map(String).map((item) => item.trim()).filter(Boolean))];
}

export function loadConfig(projectRoot = process.cwd()) {
  const configuredPath =
    process.env.LILILO_CONFIG || process.env.QQ_BOT_CONFIG || "config.json";
  const configPath = path.resolve(projectRoot, configuredPath);
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Config not found: ${configPath}. Copy config.example.json to config.json first.`,
    );
  }

  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const onebot = requiredObject(config.onebot, "onebot");
  const webui = requiredObject(config.webui ?? {}, "webui");
  const qq = requiredObject(config.qq, "qq");
  const llm = requiredObject(config.llm, "llm");
  const bot = requiredObject(config.bot, "bot");
  const storage = requiredObject(config.storage, "storage");
  const observation = requiredObject(config.observation ?? {}, "observation");
  const tools = requiredObject(config.tools ?? {}, "tools");

  onebot.host ||= "127.0.0.1";
  onebot.port = positiveInteger(onebot.port, "config.onebot.port");
  onebot.path ||= "/ws";
  onebot.accessToken = process.env.ONEBOT_ACCESS_TOKEN ?? onebot.accessToken ?? "";
  onebot.heartbeatTimeoutMs = positiveInteger(
    onebot.heartbeatTimeoutMs ?? 90000,
    "config.onebot.heartbeatTimeoutMs",
  );
  onebot.healthCheckIntervalMs = positiveInteger(
    onebot.healthCheckIntervalMs ?? 15000,
    "config.onebot.healthCheckIntervalMs",
  );
  if (onebot.healthCheckIntervalMs >= onebot.heartbeatTimeoutMs) {
    throw new Error("config.onebot.healthCheckIntervalMs must be less than heartbeatTimeoutMs");
  }
  if (!onebot.path.startsWith("/")) throw new Error("config.onebot.path must start with /");

  webui.enabled = webui.enabled !== false;
  webui.host ||= "127.0.0.1";
  webui.port = positiveInteger(webui.port ?? 8400, "config.webui.port");
  webui.accessToken = process.env.WEBUI_ACCESS_TOKEN ?? webui.accessToken ?? "";
  const webuiIsLoopback = ["127.0.0.1", "::1", "localhost"].includes(webui.host);
  if (webui.enabled && !webuiIsLoopback && !webui.accessToken) {
    throw new Error("config.webui.accessToken is required when WebUI is not bound to loopback");
  }

  qq.adminUsers = normalizeIdList(qq.adminUsers ?? [], "config.qq.adminUsers");
  qq.privateAllowlist = normalizeIdList(
    qq.privateAllowlist ?? [],
    "config.qq.privateAllowlist",
  );
  qq.allowedGroups = normalizeIdList(qq.allowedGroups ?? [], "config.qq.allowedGroups");
  qq.groupKeywords = (qq.groupKeywords ?? [])
    .map(String)
    .map((item) => item.trim())
    .filter(Boolean);
  qq.allowPrivate = qq.allowPrivate !== false;
  qq.quoteReply = qq.quoteReply !== false;
  qq.mentionReplyInGroups = qq.mentionReplyInGroups !== false;

  llm.baseUrl = (process.env.OPENAI_BASE_URL ?? llm.baseUrl ?? "").replace(/\/$/, "");
  llm.apiKey = process.env.OPENAI_API_KEY ?? llm.apiKey ?? "";
  llm.model = process.env.OPENAI_MODEL ?? llm.model ?? "";
  llm.timeoutMs = positiveInteger(llm.timeoutMs ?? 120000, "config.llm.timeoutMs");
  llm.temperature = Number(llm.temperature ?? 0.7);
  if (!llm.baseUrl || !llm.model) throw new Error("config.llm.baseUrl and model are required");

  bot.name ||= "莉莉洛";
  bot.maxHistoryTurns = positiveInteger(
    bot.maxHistoryTurns ?? 20,
    "config.bot.maxHistoryTurns",
  );
  bot.systemPromptFile = path.resolve(projectRoot, bot.systemPromptFile);
  storage.sessionsDir = path.resolve(projectRoot, storage.sessionsDir);

  observation.enabled = observation.enabled === true;
  observation.allGroups = observation.allGroups === true;
  observation.groups = normalizeIdList(observation.groups ?? [], "config.observation.groups");
  observation.analysisIntervalMinutes = positiveInteger(
    observation.analysisIntervalMinutes ?? 360,
    "config.observation.analysisIntervalMinutes",
  );
  observation.retentionDays = positiveInteger(
    observation.retentionDays ?? 30,
    "config.observation.retentionDays",
  );
  observation.minMessages = positiveInteger(
    observation.minMessages ?? 10,
    "config.observation.minMessages",
  );
  observation.maxMessagesPerAnalysis = positiveInteger(
    observation.maxMessagesPerAnalysis ?? 500,
    "config.observation.maxMessagesPerAnalysis",
  );
  storage.observationsDir = path.resolve(
    projectRoot,
    storage.observationsDir ?? "data/observations",
  );

  tools.enabled = tools.enabled === true;
  tools.maxRounds = positiveInteger(tools.maxRounds ?? 5, "config.tools.maxRounds");
  if (tools.maxRounds > 10) throw new Error("config.tools.maxRounds must not exceed 10");
  tools.search = requiredObject(tools.search ?? {}, "tools.search");
  tools.search.enabled = tools.search.enabled === true;
  tools.search.baseUrl = String(tools.search.baseUrl ?? "").replace(/\/$/, "");
  if (tools.search.enabled) {
    let searchUrl;
    try { searchUrl = new URL(tools.search.baseUrl); }
    catch { throw new Error("config.tools.search.baseUrl must be a valid URL when search is enabled"); }
    if (!['http:', 'https:'].includes(searchUrl.protocol) || searchUrl.username || searchUrl.password) {
      throw new Error("config.tools.search.baseUrl must be an HTTP(S) URL without credentials");
    }
  }
  tools.search.language ||= "zh-CN";
  tools.search.timeoutMs = positiveInteger(tools.search.timeoutMs ?? 10000, "config.tools.search.timeoutMs");
  tools.search.maxResults = positiveInteger(tools.search.maxResults ?? 5, "config.tools.search.maxResults");
  tools.fetch = requiredObject(tools.fetch ?? {}, "tools.fetch");
  tools.fetch.enabled = tools.fetch.enabled === true;
  tools.fetch.timeoutMs = positiveInteger(tools.fetch.timeoutMs ?? 10000, "config.tools.fetch.timeoutMs");
  tools.fetch.maxBytes = positiveInteger(tools.fetch.maxBytes ?? 512000, "config.tools.fetch.maxBytes");
  tools.fetch.maxTextChars = positiveInteger(tools.fetch.maxTextChars ?? 12000, "config.tools.fetch.maxTextChars");
  tools.scripts = requiredObject(tools.scripts ?? {}, "tools.scripts");
  tools.scripts.enabled = tools.scripts.enabled === true;
  tools.scripts.directory ||= "tools/scripts";
  tools.scripts.allowQqAdminPrivate = tools.scripts.allowQqAdminPrivate === true;
  tools.scripts.timeoutMs = positiveInteger(tools.scripts.timeoutMs ?? 10000, "config.tools.scripts.timeoutMs");
  tools.scripts.maxOutputBytes = positiveInteger(tools.scripts.maxOutputBytes ?? 20000, "config.tools.scripts.maxOutputBytes");

  return { ...config, onebot, webui, qq, llm, bot, storage, observation, tools, projectRoot, configPath };
}
