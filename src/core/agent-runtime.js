import fs from "node:fs/promises";
import { SessionQueue } from "./session-queue.js";

export class AgentRuntime {
  constructor(config, store, llm, logger = null, tools = null) {
    this.config = config;
    this.store = store;
    this.llm = llm;
    this.logger = logger;
    this.tools = tools;
    this.queue = new SessionQueue();
  }

  async init() {
    this.systemPrompt = await fs.readFile(this.config.bot.systemPromptFile, "utf8");
  }

  async chat({ key, content, contextPrefix = "", persist = true, context = {} }) {
    const input = String(content ?? "").trim();
    if (!input) throw new Error("message is required");
    return this.queue.run(key, async () => {
      const history = persist ? await this.store.get(key) : [];
      const userContent = `${contextPrefix}${input}`;
      this.logger?.info("agent", `turn started session=${key}`);
      const answer = await this.run(history, userContent, context);
      if (persist) {
        await this.store.append(key, [
          { role: "user", content: userContent },
          { role: "assistant", content: answer },
        ]);
      }
      this.logger?.info("agent", `turn completed session=${key}`);
      return { answer, key };
    });
  }

  async run(history, userContent, context) {
    const definitions = this.config.tools?.enabled && this.tools
      ? this.tools.definitions(context)
      : [];
    if (!definitions.length || typeof this.llm.complete !== "function") {
      return this.llm.chat(this.systemPrompt, history, userContent);
    }
    const messages = [
      { role: "system", content: this.systemPrompt },
      ...history,
      { role: "user", content: userContent },
    ];
    const maxRounds = this.config.tools?.maxRounds ?? 5;
    for (let round = 0; round < maxRounds; round += 1) {
      const message = await this.llm.complete(messages, definitions);
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      if (!calls.length) {
        const answer = String(message.content ?? "").trim();
        if (!answer) throw new Error("model returned neither text nor tool calls");
        return answer;
      }
      messages.push({ role: "assistant", content: message.content ?? null, tool_calls: calls });
      for (const call of calls) {
        const name = String(call.function?.name ?? "");
        let args;
        try { args = JSON.parse(call.function?.arguments || "{}"); }
        catch { args = null; }
        let content;
        try { content = await this.tools.execute(name, args, context); }
        catch (error) { content = JSON.stringify({ error: error.code ?? "tool_failed", message: error.message }); }
        messages.push({ role: "tool", tool_call_id: call.id, content: content.slice(0, 24000) });
      }
    }
    throw new Error(`tool call rounds exceeded ${maxRounds}`);
  }

  history(key) {
    return this.store.get(key);
  }

  reset(key) {
    return this.queue.run(key, () => this.store.reset(key));
  }
}
