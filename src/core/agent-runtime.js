import fs from "node:fs/promises";
import { SessionQueue } from "./session-queue.js";

export class AgentRuntime {
  constructor(config, store, llm, logger = null) {
    this.config = config;
    this.store = store;
    this.llm = llm;
    this.logger = logger;
    this.queue = new SessionQueue();
  }

  async init() {
    this.systemPrompt = await fs.readFile(this.config.bot.systemPromptFile, "utf8");
  }

  async chat({ key, content, contextPrefix = "", persist = true }) {
    const input = String(content ?? "").trim();
    if (!input) throw new Error("message is required");
    return this.queue.run(key, async () => {
      const history = persist ? await this.store.get(key) : [];
      const userContent = `${contextPrefix}${input}`;
      this.logger?.info("agent", `turn started session=${key}`);
      const answer = await this.llm.chat(this.systemPrompt, history, userContent);
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

  history(key) {
    return this.store.get(key);
  }

  reset(key) {
    return this.queue.run(key, () => this.store.reset(key));
  }
}
