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

test("AgentRuntime executes an allowed tool and returns the final answer", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lililo-tools-"));
  const prompt = path.join(directory, "system.md");
  await fs.writeFile(prompt, "persona");
  const store = new ConversationStore(path.join(directory, "sessions"), 10);
  await store.init();
  let round = 0;
  const llm = {
    complete: async (messages, definitions) => {
      assert.equal(definitions[0].function.name, "status");
      if (round++ === 0) return {
        content: null,
        tool_calls: [{ id: "call-1", function: { name: "status", arguments: "{}" } }],
      };
      assert.equal(messages.at(-1).role, "tool");
      assert.equal(messages.at(-1).content, "healthy");
      return { content: "一切正常。" };
    },
  };
  const tools = {
    definitions: () => [{ type: "function", function: { name: "status" } }],
    execute: async () => "healthy",
  };
  const config = { bot: { systemPromptFile: prompt }, tools: { enabled: true, maxRounds: 3 } };
  const agent = new AgentRuntime(config, store, llm, null, tools);
  await agent.init();
  try {
    const result = await agent.chat({ key: "local:web:test", content: "检查状态", context: { channel: "web" } });
    assert.equal(result.answer, "一切正常。");
    assert.equal((await agent.history("local:web:test")).length, 2);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
