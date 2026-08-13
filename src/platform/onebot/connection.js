import crypto from "node:crypto";

export class OneBotConnection {
  constructor(socket, selfId = "") {
    this.socket = socket;
    this.selfId = selfId;
    this.pending = new Map();
    this.connectedAt = Date.now();
    this.lastActivityAt = this.connectedAt;
    this.lastHeartbeatAt = null;
    socket.on("message", (data) => {
      this.lastActivityAt = Date.now();
      this.onFrame?.(data.toString());
    });
    socket.on("pong", () => { this.lastActivityAt = Date.now(); });
    socket.on("close", () => this.rejectPending(new Error("OneBot connection closed")));
    socket.on("error", (error) => this.rejectPending(error));
  }

  observeFrame(frame) {
    this.lastActivityAt = Date.now();
    if (frame?.post_type === "meta_event" && frame?.meta_event_type === "heartbeat") {
      this.lastHeartbeatAt = this.lastActivityAt;
      return true;
    }
    return false;
  }

  healthy(now, timeoutMs) {
    return this.socket.readyState === 1 && now - this.lastActivityAt <= timeoutMs;
  }

  handleApiResponse(frame) {
    if (frame.echo === undefined || frame.echo === null) return false;
    const pending = this.pending.get(String(frame.echo));
    if (!pending) return false;
    clearTimeout(pending.timeout);
    this.pending.delete(String(frame.echo));
    if (frame.status === "ok" && Number(frame.retcode ?? 0) === 0) pending.resolve(frame.data);
    else pending.reject(new Error(`OneBot API failed: ${frame.message || frame.wording || frame.retcode}`));
    return true;
  }

  call(action, params, timeoutMs = 15000) {
    if (this.socket.readyState !== 1) {
      return Promise.reject(new Error("OneBot connection is not open"));
    }
    const echo = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`OneBot API timeout: ${action}`));
      }, timeoutMs);
      this.pending.set(echo, { resolve, reject, timeout });
      this.socket.send(JSON.stringify({ action, params, echo }), (error) => {
        if (!error) return;
        clearTimeout(timeout);
        this.pending.delete(echo);
        reject(error);
      });
    });
  }

  async sendText(message, text, replyConfig) {
    const segments = [];
    if (replyConfig.quoteReply && message.messageId) {
      segments.push({ type: "reply", data: { id: message.messageId } });
    }
    if (message.kind === "group" && replyConfig.mentionReplyInGroups) {
      segments.push({ type: "at", data: { qq: message.senderId } });
      segments.push({ type: "text", data: { text: " " } });
    }
    segments.push({ type: "text", data: { text } });
    const group = message.kind === "group";
    return this.call(group ? "send_group_msg" : "send_private_msg", {
      [group ? "group_id" : "user_id"]: Number(message.conversationId),
      message: segments,
    });
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
