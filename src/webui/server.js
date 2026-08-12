import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

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
    },
    webui: {
      host: config.webui.host,
      port: config.webui.port,
      accessTokenConfigured: Boolean(config.webui.accessToken),
    },
  };
}

export class WebUiServer {
  constructor(config, { store, onebot, agent, logger }) {
    this.config = config;
    this.store = store;
    this.onebot = onebot;
    this.agent = agent;
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
        return json(response, 502, { error: "model_request_failed" });
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
      this.sseClients.add(response);
      const keepalive = setInterval(() => response.write(": keepalive\n\n"), 15000);
      request.on("close", () => {
        clearInterval(keepalive);
        unsubscribe();
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
      "cache-control": name === "index.html" ? "no-cache" : "public, max-age=300",
    });
    response.end(content);
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
