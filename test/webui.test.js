import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Logger } from "../src/core/logger.js";
import { AgentRuntime } from "../src/core/agent-runtime.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { WebUiServer } from "../src/webui/server.js";
import { ModelRequestError } from "../src/services/openai-client.js";

test("WebUI protects APIs, redacts secrets, and manages sessions", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "qq-agent-webui-"));
  const store = new ConversationStore(temporary, 10);
  await store.init();
  await store.append("onebot:42:private:7", [
    { role: "user", content: "hello" },
    { role: "assistant", content: "world" },
  ]);
  const logger = new Logger();
  const projectRoot = path.resolve(import.meta.dirname, "..");
  const config = {
    projectRoot,
    webui: { host: "127.0.0.1", port: 0, accessToken: "web-secret" },
    onebot: { host: "127.0.0.1", port: 8300, path: "/ws", accessToken: "onebot-secret" },
    qq: {
      adminUsers: ["7"], privateAllowlist: ["7"], allowedGroups: ["9"],
      groupKeywords: ["莉莉洛"], allowPrivate: true, quoteReply: true,
      mentionReplyInGroups: true,
    },
    llm: { baseUrl: "https://example.test/v1", apiKey: "llm-secret", model: "test-model", temperature: 0.7, timeoutMs: 1000 },
    bot: { name: "Test Bot", maxHistoryTurns: 10 },
  };
  config.configPath = path.join(temporary, "config.json");
  await fs.writeFile(config.configPath, `${JSON.stringify({ llm: config.llm }, null, 2)}\n`);
  const onebot = {
    status: () => ({ listening: true, host: "127.0.0.1", port: 8300, path: "/ws", connectedAccounts: ["42"] }),
  };
  const llm = {
    chat: async (_prompt, history, message) => `reply:${history.length}:${message}`,
  };
  config.bot.systemPromptFile = path.join(temporary, "system.md");
  await fs.writeFile(config.bot.systemPromptFile, "test system prompt");
  const agent = new AgentRuntime(config, store, llm, logger);
  await agent.init();
  const webui = new WebUiServer(config, { store, onebot, agent, logger });
  const server = webui.start();
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(`${baseUrl}/`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("cache-control"), "no-cache");
    assert.equal((await fetch(`${baseUrl}/api/status`)).status, 401);
    const headers = { authorization: "Bearer web-secret" };
    const status = await fetch(`${baseUrl}/api/status`, { headers }).then((response) => response.json());
    assert.deepEqual(status.onebot.connectedAccounts, ["42"]);

    const publicConfig = await fetch(`${baseUrl}/api/config`, { headers }).then((response) => response.json());
    assert.equal(publicConfig.llm.apiKey, undefined);
    assert.equal(publicConfig.llm.apiKeyConfigured, true);
    assert.equal(publicConfig.onebot.accessToken, undefined);

    const updatedSettings = await fetch(`${baseUrl}/api/model-settings`, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: "https://new.example.test/v1/",
        model: "new-model",
        apiKey: "new-secret",
        temperature: 0.4,
        timeoutMs: 5000,
      }),
    }).then((response) => response.json());
    assert.equal(updatedSettings.ok, true);
    assert.equal(updatedSettings.llm.baseUrl, "https://new.example.test/v1");
    assert.equal(updatedSettings.llm.apiKey, undefined);
    assert.equal(config.llm.model, "new-model");
    const savedConfig = JSON.parse(await fs.readFile(config.configPath, "utf8"));
    assert.equal(savedConfig.llm.apiKey, "new-secret");
    assert.equal(savedConfig.llm.model, "new-model");
    assert.equal((await fs.stat(config.configPath)).mode & 0o777, 0o600);

    const chatResponse = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ channel: "web", sessionId: "browser-1", message: "你好" }),
    }).then((response) => response.json());
    assert.equal(chatResponse.answer, "reply:0:你好");
    const chatHistory = await fetch(`${baseUrl}/api/chat/web/browser-1`, { headers }).then((response) => response.json());
    assert.equal(chatHistory.messages.length, 2);
    assert.equal(chatHistory.messages[0].content, "你好");
    assert.equal((await fetch(`${baseUrl}/api/chat/web/browser-1`, { method: "DELETE", headers })).status, 200);
    const emptyChat = await fetch(`${baseUrl}/api/chat/web/browser-1`, { headers }).then((response) => response.json());
    assert.equal(emptyChat.messages.length, 0);

    llm.chat = async () => {
      throw new ModelRequestError("model_rate_limited", 429, "模型服务暂时繁忙，请稍后再试");
    };
    const limited = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ channel: "web", sessionId: "limited", message: "你好" }),
    });
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), {
      error: "model_rate_limited",
      message: "模型服务暂时繁忙，请稍后再试",
    });

    const sessions = await fetch(`${baseUrl}/api/sessions`, { headers }).then((response) => response.json());
    assert.equal(sessions.sessions.length, 1);
    const id = sessions.sessions[0].id;
    const detail = await fetch(`${baseUrl}/api/sessions/${id}`, { headers }).then((response) => response.json());
    assert.equal(detail.messages.length, 2);
    assert.equal((await fetch(`${baseUrl}/api/sessions/${id}`, { method: "DELETE", headers })).status, 200);
    const after = await fetch(`${baseUrl}/api/sessions`, { headers }).then((response) => response.json());
    assert.equal(after.sessions.length, 0);
  } finally {
    await webui.stop();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
