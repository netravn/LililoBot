import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { OpenAiClient, ModelRequestError } from "../services/openai-client.js";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

function loopback(address) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address);
}

function safeEqual(left, right) {
  const leftHash = crypto.createHash("sha256").update(left).digest();
  const rightHash = crypto.createHash("sha256").update(right).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

function json(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function readJson(request, maximumBytes = 64 * 1024) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > maximumBytes) {
      const error = new Error("request body is too large");
      error.statusCode = 413;
      throw error;
    }
  }
  try {
    return JSON.parse(body || "{}");
  } catch {
    const error = new Error("invalid JSON body");
    error.statusCode = 400;
    throw error;
  }
}

function localSession(channel, id) {
  if (!['web', 'cli'].includes(channel)) throw Object.assign(new Error("invalid channel"), { statusCode: 400 });
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
    throw Object.assign(new Error("invalid session id"), { statusCode: 400 });
  }
  return `local:${channel}:${id}`;
}

function publicConfig(config) {
  return {
    bot: {
      name: config.bot.name,
      maxHistoryTurns: config.bot.maxHistoryTurns,
    },
    onebot: {
      host: config.onebot.host,
      port: config.onebot.port,
      path: config.onebot.path,
      accessTokenConfigured: Boolean(config.onebot.accessToken),
    },
    qq: config.qq,
    llm: {
      baseUrl: config.llm.baseUrl,
      model: config.llm.model,
      temperature: config.llm.temperature,
      timeoutMs: config.llm.timeoutMs,
      apiKeyConfigured: Boolean(config.llm.apiKey),
      managedByEnvironment: {
        baseUrl: Boolean(process.env.OPENAI_BASE_URL),
        apiKey: Boolean(process.env.OPENAI_API_KEY),
        model: Boolean(process.env.OPENAI_MODEL),
      },
    },
    webui: {
      host: config.webui.host,
      port: config.webui.port,
      accessTokenConfigured: Boolean(config.webui.accessToken),
    },
    observation: { ...config.observation },
  };
}

function observationSettings(body, current) {
  const enabled = body.enabled === undefined ? current.enabled : body.enabled === true;
  const allGroups = body.allGroups === undefined ? current.allGroups : body.allGroups === true;
  const groups = body.groups === undefined
    ? current.groups
    : [...new Set((Array.isArray(body.groups) ? body.groups : String(body.groups).split(/[\s,，]+/))
      .map(String).map((item) => item.trim()).filter(Boolean))];
  if (groups.some((id) => !/^\d{1,20}$/.test(id))) {
    throw Object.assign(new Error("群号必须是 1-20 位数字"), { statusCode: 400 });
  }
  const integer = (key, minimum, maximum) => {
    const value = Number(body[key] ?? current[key]);
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw Object.assign(new Error(`${key} 必须在 ${minimum}-${maximum} 之间`), { statusCode: 400 });
    }
    return value;
  };
  return {
    enabled,
    allGroups,
    groups,
    analysisIntervalMinutes: integer("analysisIntervalMinutes", 5, 10080),
    retentionDays: integer("retentionDays", 1, 3650),
    minMessages: integer("minMessages", 1, 10000),
    maxMessagesPerAnalysis: integer("maxMessagesPerAnalysis", 10, 5000),
  };
}

function modelSettings(body, current) {
  const baseUrl = String(body.baseUrl ?? current.baseUrl).trim().replace(/\/$/, "");
  let parsedUrl;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    throw Object.assign(new Error("API URL 格式无效"), { statusCode: 400 });
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
    throw Object.assign(new Error("API URL 必须是无账号信息的 HTTP(S) 地址"), { statusCode: 400 });
  }
  const model = String(body.model ?? current.model).trim();
  if (!model || model.length > 200) {
    throw Object.assign(new Error("模型名称必须包含 1-200 个字符"), { statusCode: 400 });
  }
  const temperature = Number(body.temperature ?? current.temperature);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw Object.assign(new Error("Temperature 必须在 0-2 之间"), { statusCode: 400 });
  }
  const timeoutMs = Number(body.timeoutMs ?? current.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) {
    throw Object.assign(new Error("超时时间必须在 1000-600000 ms 之间"), { statusCode: 400 });
  }
  let apiKey = current.apiKey;
  if (body.clearApiKey === true) apiKey = "";
  else if (typeof body.apiKey === "string" && body.apiKey.trim()) apiKey = body.apiKey.trim();
  return { baseUrl, apiKey, model, temperature, timeoutMs };
}

function modelErrorPayload(error) {
  if (error instanceof ModelRequestError) {
    return { status: error.statusCode, body: { error: error.code, message: error.message } };
  }
  return { status: 502, body: { error: "model_request_failed", message: "模型请求失败" } };
}

export class WebUiServer {
  constructor(config, { store, onebot, agent, observer = null, logger }) {
    this.config = config;
    this.store = store;
    this.onebot = onebot;
    this.agent = agent;
    this.observer = observer;
    this.logger = logger;
    this.startedAt = Date.now();
    this.publicDir = path.join(config.projectRoot, "web");
    this.sseClients = new Set();
  }

  start() {
    this.server = http.createServer((request, response) => {
      this.handle(request, response).catch((error) => {
        this.logger.error("webui", error);
        if (!response.headersSent) {
          const status = error.statusCode ?? 500;
          json(response, status, { error: status === 500 ? "internal_error" : error.message });
        }
        else response.end();
      });
    });
    this.server.listen(this.config.webui.port, this.config.webui.host, () => {
      const address = this.server.address();
      const port = typeof address === "object" && address ? address.port : this.config.webui.port;
      this.logger.info("webui", `ready http://${this.config.webui.host}:${port}`);
    });
    return this.server;
  }

  authorized(request, url) {
    if (!this.config.webui.accessToken) return loopback(request.socket.remoteAddress);
    const header = String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
    const supplied = header || url.searchParams.get("token") || "";
    return safeEqual(this.config.webui.accessToken, supplied);
  }

  async handle(request, response) {
    const url = new URL(request.url, "http://localhost");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("x-frame-options", "DENY");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader(
      "content-security-policy",
      "default-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
    );

    if (url.pathname.startsWith("/api/")) {
      if (!this.authorized(request, url)) return json(response, 401, { error: "unauthorized" });
      return this.handleApi(request, response, url);
    }
    return this.serveStatic(response, url.pathname);
  }

  async handleApi(request, response, url) {
    if (request.method === "POST" && url.pathname === "/api/chat") {
      const body = await readJson(request);
      const message = String(body.message ?? "").trim();
      if (!message || message.length > 20_000) {
        return json(response, 400, { error: "message must contain 1-20000 characters" });
      }
      const channel = String(body.channel ?? "web");
      const sessionId = String(body.sessionId ?? "default");
      const key = localSession(channel, sessionId);
      try {
        const result = await this.agent.chat({
          key,
          content: message,
          persist: body.transient !== true,
        });
        return json(response, 200, { answer: result.answer, channel, sessionId });
      } catch (error) {
        this.logger.error("webui", `chat failed session=${key}`, error);
        const failure = modelErrorPayload(error);
        return json(response, failure.status, failure.body);
      }
    }
    const chatMatch = url.pathname.match(/^\/api\/chat\/(web|cli)\/([a-zA-Z0-9_-]{1,64})$/);
    if (chatMatch && request.method === "GET") {
      const [channel, sessionId] = chatMatch.slice(1);
      return json(response, 200, {
        channel,
        sessionId,
        messages: await this.agent.history(localSession(channel, sessionId)),
      });
    }
    if (chatMatch && request.method === "DELETE") {
      const [channel, sessionId] = chatMatch.slice(1);
      await this.agent.reset(localSession(channel, sessionId));
      this.logger.warn("webui", `local chat reset channel=${channel} session=${sessionId}`);
      return json(response, 200, { ok: true });
    }
    if (request.method === "GET" && url.pathname === "/api/status") {
      const sessions = await this.store.list();
      return json(response, 200, {
        ok: true,
        uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
        nodeVersion: process.version,
        onebot: this.onebot.status(),
        llm: { model: this.config.llm.model, configured: Boolean(this.config.llm.apiKey) },
        sessions: sessions.length,
      });
    }
    if (request.method === "GET" && url.pathname === "/api/config") {
      return json(response, 200, publicConfig(this.config));
    }
    if (request.method === "GET" && url.pathname === "/api/observation") {
      if (!this.observer) return json(response, 503, { error: "observer_unavailable" });
      return json(response, 200, await this.observer.status());
    }
    if (request.method === "PUT" && url.pathname === "/api/observation-settings") {
      if (!this.observer) return json(response, 503, { error: "observer_unavailable" });
      const next = observationSettings(await readJson(request), this.config.observation);
      await this.saveObservationSettings(next);
      this.observer.updateSettings(next);
      return json(response, 200, { ok: true, observation: { ...next } });
    }
    if (request.method === "POST" && url.pathname === "/api/observation/run") {
      if (!this.observer) return json(response, 503, { error: "observer_unavailable" });
      const body = await readJson(request);
      const groupId = body.groupId == null || body.groupId === "" ? null : String(body.groupId);
      if (groupId && !/^\d{1,20}$/.test(groupId)) return json(response, 400, { error: "invalid_group_id" });
      try {
        const results = await this.observer.runAnalysis({ groupId, force: body.force === true });
        return json(response, 200, { ok: true, results });
      } catch (error) {
        const failure = modelErrorPayload(error);
        if (error.statusCode === 409) return json(response, 409, { error: "analysis_running", message: error.message });
        return json(response, failure.status, failure.body);
      }
    }
    const observationMatch = url.pathname.match(/^\/api\/observation\/groups\/(\d{1,20})\/(messages|summaries)$/);
    if (observationMatch && request.method === "GET") {
      if (!this.observer) return json(response, 503, { error: "observer_unavailable" });
      const [, groupId, type] = observationMatch;
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100), 1), 500);
      if (type === "messages") {
        return json(response, 200, { groupId, messages: await this.observer.store.messages(groupId, { limit, newest: true }) });
      }
      return json(response, 200, { groupId, summaries: await this.observer.store.summaries(groupId, limit) });
    }
    if (request.method === "PUT" && url.pathname === "/api/model-settings") {
      const body = await readJson(request);
      const next = modelSettings(body, this.config.llm);
      const managed = publicConfig(this.config).llm.managedByEnvironment;
      if (managed.baseUrl && next.baseUrl !== this.config.llm.baseUrl) {
        return json(response, 409, { error: "managed_by_environment", message: "API URL 由 OPENAI_BASE_URL 控制" });
      }
      if (managed.model && next.model !== this.config.llm.model) {
        return json(response, 409, { error: "managed_by_environment", message: "模型由 OPENAI_MODEL 控制" });
      }
      if (managed.apiKey && next.apiKey !== this.config.llm.apiKey) {
        return json(response, 409, { error: "managed_by_environment", message: "API Key 由 OPENAI_API_KEY 控制" });
      }
      await this.saveModelSettings(next, managed);
      Object.assign(this.config.llm, next);
      if (this.agent.llm?.config) Object.assign(this.agent.llm.config, next);
      this.logger.info("webui", `model settings updated model=${next.model} base_url=${next.baseUrl}`);
      return json(response, 200, { ok: true, llm: publicConfig(this.config).llm });
    }
    if (request.method === "POST" && url.pathname === "/api/model-settings/test") {
      const body = await readJson(request);
      const candidate = modelSettings(body, this.config.llm);
      try {
        const answer = await new OpenAiClient(candidate).chat(
          "Respond with exactly OK.",
          [],
          "Connection test",
        );
        return json(response, 200, { ok: true, model: candidate.model, answer: answer.slice(0, 80) });
      } catch (error) {
        this.logger.warn("webui", `model connection test failed model=${candidate.model}`, error);
        const failure = modelErrorPayload(error);
        return json(response, failure.status, failure.body);
      }
    }
    if (request.method === "GET" && url.pathname === "/api/sessions") {
      return json(response, 200, { sessions: await this.store.list() });
    }
    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([a-f0-9]{64})$/);
    if (sessionMatch && request.method === "GET") {
      try {
        return json(response, 200, await this.store.getById(sessionMatch[1]));
      } catch (error) {
        if (error.code === "ENOENT") return json(response, 404, { error: "not_found" });
        throw error;
      }
    }
    if (sessionMatch && request.method === "DELETE") {
      const deleted = await this.store.resetById(sessionMatch[1]);
      if (deleted) this.logger.warn("webui", `session reset id=${sessionMatch[1]}`);
      return json(response, deleted ? 200 : 404, { ok: deleted });
    }
    if (request.method === "GET" && url.pathname === "/api/logs") {
      const limit = Number(url.searchParams.get("limit") ?? 200);
      return json(response, 200, { entries: this.logger.recent(limit) });
    }
    if (request.method === "GET" && url.pathname === "/api/events") {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });
      for (const entry of this.logger.recent(100)) {
        response.write(`id: ${entry.id}\nevent: log\ndata: ${JSON.stringify(entry)}\n\n`);
      }
      const unsubscribe = this.logger.subscribe((entry) => {
        response.write(`id: ${entry.id}\nevent: log\ndata: ${JSON.stringify(entry)}\n\n`);
      });
      const unsubscribeObservation = this.observer?.subscribe((event) => {
        response.write(`event: observation\ndata: ${JSON.stringify(event)}\n\n`);
      });
      this.sseClients.add(response);
      const keepalive = setInterval(() => response.write(": keepalive\n\n"), 15000);
      request.on("close", () => {
        clearInterval(keepalive);
        unsubscribe();
        unsubscribeObservation?.();
        this.sseClients.delete(response);
      });
      return;
    }
    return json(response, 404, { error: "not_found" });
  }

  async serveStatic(response, pathname) {
    const files = {
      "/": "index.html",
      "/index.html": "index.html",
      "/app.js": "app.js",
      "/styles.css": "styles.css",
    };
    if (pathname === "/avatar.png") {
      const content = await fs.readFile(path.join(this.config.projectRoot, "assets", "lililo-avatar-square.png"));
      response.writeHead(200, {
        "content-type": "image/png",
        "cache-control": "public, max-age=3600",
      });
      response.end(content);
      return;
    }
    const name = files[pathname];
    if (!name) return json(response, 404, { error: "not_found" });
    const content = await fs.readFile(path.join(this.publicDir, name));
    response.writeHead(200, {
      "content-type": MIME_TYPES[path.extname(name)] ?? "application/octet-stream",
      "cache-control": "no-cache",
    });
    response.end(content);
  }

  async saveModelSettings(settings, managed = {}) {
    const configPath = this.config.configPath ?? path.join(this.config.projectRoot, "config.json");
    const raw = JSON.parse(await fs.readFile(configPath, "utf8"));
    const persisted = { ...(raw.llm ?? {}) };
    for (const key of ["baseUrl", "apiKey", "model", "temperature", "timeoutMs"]) {
      if (!managed[key]) persisted[key] = settings[key];
    }
    raw.llm = persisted;
    const temporary = `${configPath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, configPath);
  }

  async saveObservationSettings(settings) {
    const configPath = this.config.configPath ?? path.join(this.config.projectRoot, "config.json");
    const raw = JSON.parse(await fs.readFile(configPath, "utf8"));
    raw.observation = settings;
    const temporary = `${configPath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, configPath);
  }

  async stop() {
    if (!this.server) return;
    for (const response of this.sseClients) response.end();
    this.sseClients.clear();
    await new Promise((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
