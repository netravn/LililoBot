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

  onebot.host ||= "127.0.0.1";
  onebot.port = positiveInteger(onebot.port, "config.onebot.port");
  onebot.path ||= "/ws";
  onebot.accessToken = process.env.ONEBOT_ACCESS_TOKEN ?? onebot.accessToken ?? "";
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

  return { ...config, onebot, webui, qq, llm, bot, storage, projectRoot };
}
