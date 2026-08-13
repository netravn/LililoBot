import { parseInboundMessage, sessionKey } from "./message.js";
import { decideTrigger } from "./trigger.js";

export class Bot {
  constructor(config, agent, logger = null, observer = null) {
    this.config = config;
    this.agent = agent;
    this.logger = logger;
    this.observer = observer;
  }

  async handleOneBotEvent(connection, event) {
    const message = parseInboundMessage(event);
    if (!message) return;
    try {
      await this.observer?.observe(message);
    } catch (error) {
      this.logger?.error("observer", `message capture failed group=${message.conversationId}`, error);
    }
    const decision = decideTrigger(message, this.config);
    if (!decision.accepted) return;
    const key = sessionKey(message);
    await this.handleMessage(connection, message, decision.content, key);
  }

  async handleMessage(connection, message, content, key) {
    const command = content.trim().toLowerCase();
    if (command === "/ping") {
      await connection.sendText(message, "pong", this.config.qq);
      return;
    }
    if (command === "/help") {
      await connection.sendText(
        message,
        "可用命令：/ping、/help、/reset。私聊直接发送，群聊请 @机器人 或使用触发词。",
        this.config.qq,
      );
      return;
    }
    if (command === "/reset") {
      await this.agent.reset(key);
      await connection.sendText(message, "当前会话已重置。", this.config.qq);
      return;
    }
    if (!content.trim()) {
      await connection.sendText(message, "你想聊什么？", this.config.qq);
      return;
    }

    const groupPrefix =
      message.kind === "group" ? `[QQ 群成员 ${message.senderName} (${message.senderId})]\n` : "";
    const userContent = `${groupPrefix}${content.trim()}`;
    try {
      const { answer } = await this.agent.chat({
        key,
        content: userContent,
        context: {
          channel: "qq",
          kind: message.kind,
          senderId: message.senderId,
          conversationId: message.conversationId,
          isAdmin: this.config.qq.adminUsers.includes(message.senderId),
        },
      });
      await connection.sendText(message, answer, this.config.qq);
    } catch (error) {
      if (this.logger) this.logger.error("bot", `session=${key}`, error);
      else console.error(`[bot] session=${key}`, error);
      await connection.sendText(message, "处理消息时发生错误，请稍后再试。", this.config.qq);
    }
  }
}
