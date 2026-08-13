import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { OneBotConnection } from "./connection.js";

function loopback(address) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address);
}

function suppliedToken(request) {
  const value = String(request.headers.authorization ?? "").trim();
  return value.replace(/^(Bearer|Token)\s+/i, "").trim();
}

function tokenMatches(expected, supplied) {
  const left = crypto.createHash("sha256").update(expected).digest();
  const right = crypto.createHash("sha256").update(supplied).digest();
  return crypto.timingSafeEqual(left, right);
}

export class OneBotServer {
  constructor(config, onEvent, logger = null) {
    this.config = config;
    this.onEvent = onEvent;
    this.logger = logger;
    this.connections = new Set();
    this.accounts = new Map();
    this.heartbeatTimeoutMs = config.heartbeatTimeoutMs ?? 90_000;
    this.healthCheckIntervalMs = config.healthCheckIntervalMs ?? 15_000;
  }

  start() {
    this.server = new WebSocketServer({
      host: this.config.host,
      port: this.config.port,
      path: this.config.path,
      verifyClient: ({ req }, done) => {
        const remote = req.socket.remoteAddress;
        const authorized = this.config.accessToken
          ? tokenMatches(this.config.accessToken, suppliedToken(req))
          : loopback(remote);
        done(authorized, authorized ? 200 : 401, authorized ? "OK" : "Unauthorized");
      },
    });

    this.server.on("connection", (socket, request) => {
      const connection = new OneBotConnection(socket, String(request.headers["x-self-id"] ?? ""));
      this.connections.add(connection);
      if (connection.selfId) this.bindAccount(connection);
      this.log("info", `connected self_id=${connection.selfId || "pending"}`);
      connection.onFrame = async (raw) => {
        let frame;
        try {
          frame = JSON.parse(raw);
        } catch {
          return;
        }
        if (connection.handleApiResponse(frame)) return;
        if (frame.self_id) {
          connection.selfId = String(frame.self_id);
          this.bindAccount(connection);
        }
        if (connection.observeFrame(frame)) return;
        try {
          await this.onEvent(connection, frame);
        } catch (error) {
          this.log("error", "event failed", error);
        }
      };
      socket.on("close", () => {
        this.connections.delete(connection);
        if (this.accounts.get(connection.selfId) === connection) {
          this.accounts.delete(connection.selfId);
        }
        this.log("info", `disconnected self_id=${connection.selfId || "unknown"}`);
      });
    });
    this.server.on("listening", () => {
      const address = this.server.address();
      const port = typeof address === "object" && address ? address.port : this.config.port;
      this.log("info", `listening ws://${this.config.host}:${port}${this.config.path}`);
    });
    this.healthTimer = setInterval(() => this.checkHealth(), this.healthCheckIntervalMs);
    this.healthTimer.unref?.();
    return this.server;
  }

  bindAccount(connection) {
    if (!connection.selfId) return;
    const previous = this.accounts.get(connection.selfId);
    if (previous === connection) return;
    this.accounts.set(connection.selfId, connection);
    if (previous?.socket.readyState === 1) {
      this.log("info", `replaced stale connection self_id=${connection.selfId}`);
      previous.socket.close(4001, "replaced by newer connection");
    }
  }

  checkHealth(now = Date.now()) {
    for (const connection of this.connections) {
      if (connection.healthy(now, this.heartbeatTimeoutMs)) {
        if (connection.socket.readyState === 1) connection.socket.ping();
        continue;
      }
      if (connection.socket.readyState === 1) {
        this.log("warn", `heartbeat timeout self_id=${connection.selfId || "pending"}`);
        connection.socket.terminate();
      }
    }
  }

  async stop() {
    clearInterval(this.healthTimer);
    for (const connection of this.connections) connection.socket.close(1001, "server shutdown");
    await new Promise((resolve, reject) => this.server.close((error) => (error ? reject(error) : resolve())));
  }

  status() {
    const now = Date.now();
    const accounts = [...this.accounts.entries()]
      .filter(([, connection]) => connection.socket.readyState === 1)
      .map(([selfId, connection]) => ({
        selfId,
        healthy: connection.healthy(now, this.heartbeatTimeoutMs),
        connectedAt: new Date(connection.connectedAt).toISOString(),
        lastActivityAt: new Date(connection.lastActivityAt).toISOString(),
        lastHeartbeatAt: connection.lastHeartbeatAt
          ? new Date(connection.lastHeartbeatAt).toISOString()
          : null,
      }));
    return {
      listening: Boolean(this.server?.address()),
      host: this.config.host,
      port: this.server?.address()?.port ?? this.config.port,
      path: this.config.path,
      connectedAccounts: accounts.filter((account) => account.healthy).map((account) => account.selfId),
      accounts,
      heartbeatTimeoutMs: this.heartbeatTimeoutMs,
    };
  }

  log(level, ...values) {
    if (this.logger) this.logger[level]("onebot", ...values);
    else (level === "error" ? console.error : console.log)("[onebot]", ...values);
  }
}
