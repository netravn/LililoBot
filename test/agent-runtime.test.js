import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentRuntime } from "../src/core/agent-runtime.js";
import { ConversationStore } from "../src/store/conversation-store.js";

test("AgentRuntime persists and isolates platform sessions", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qq-agent-runtime-"));
  const prompt = path.join(directory, "system.md");
  await fs.writeFile(prompt, "original persona");
  const config = { bot: { systemPromptFile: prompt } };
  const store = new ConversationStore(path.join(directory, "sessions"), 10);
  await store.init();
  const requests = [];
  const llm = {
    chat: async (system, history, message) => {
      requests.push({ system, history, message });
      return `answer-${history.length}`;
    },
  };
  const agent = new AgentRuntime(config, store, llm);
  await agent.init();
  try {
    assert.equal((await agent.chat({ key: "local:web:a", content: "first" })).answer, "answer-0");
    assert.equal((await agent.chat({ key: "local:web:a", content: "second" })).answer, "answer-2");
    assert.equal((await agent.chat({ key: "onebot:42:private:7", content: "qq" })).answer, "answer-0");
    assert.equal((await agent.history("local:web:a")).length, 4);
    assert.equal((await agent.history("onebot:42:private:7")).length, 2);
    await agent.chat({ key: "local:cli:ask", content: "temporary", persist: false });
    assert.equal((await agent.history("local:cli:ask")).length, 0);
    assert.equal(requests[0].system, "original persona");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
