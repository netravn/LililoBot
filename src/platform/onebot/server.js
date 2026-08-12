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
      this.log("info", `connected self_id=${connection.selfId || "pending"}`);
      connection.onFrame = async (raw) => {
        let frame;
        try {
          frame = JSON.parse(raw);
        } catch {
          return;
        }
        if (connection.handleApiResponse(frame)) return;
        if (frame.self_id) connection.selfId = String(frame.self_id);
        try {
          await this.onEvent(connection, frame);
        } catch (error) {
          this.log("error", "event failed", error);
        }
      };
      socket.on("close", () => {
        this.connections.delete(connection);
        this.log("info", `disconnected self_id=${connection.selfId || "unknown"}`);
      });
    });
    this.server.on("listening", () => {
      const address = this.server.address();
      const port = typeof address === "object" && address ? address.port : this.config.port;
      this.log("info", `listening ws://${this.config.host}:${port}${this.config.path}`);
    });
    return this.server;
  }

  async stop() {
    for (const connection of this.connections) connection.socket.close(1001, "server shutdown");
    await new Promise((resolve, reject) => this.server.close((error) => (error ? reject(error) : resolve())));
  }

  status() {
    return {
      listening: Boolean(this.server?.address()),
      host: this.config.host,
      port: this.server?.address()?.port ?? this.config.port,
      path: this.config.path,
      connectedAccounts: [...this.connections]
        .filter((connection) => connection.socket.readyState === 1)
        .map((connection) => connection.selfId || "pending"),
    };
  }

  log(level, ...values) {
    if (this.logger) this.logger[level]("onebot", ...values);
    else (level === "error" ? console.error : console.log)("[onebot]", ...values);
  }
}
