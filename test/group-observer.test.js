import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GroupObserver } from "../src/services/group-observer.js";
import { ObservationStore } from "../src/store/observation-store.js";

function groupMessage(groupId, text, senderId = "7") {
  return {
    kind: "group", selfId: "42", senderId, senderName: "Alice",
    conversationId: groupId, messageId: "11", text, images: [],
    raw: { time: Math.floor(Date.now() / 1000) },
  };
}

test("silent observer scopes group capture and creates independent summaries", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "lililo-observer-"));
  const store = new ObservationStore(temporary);
  const calls = [];
  const llm = { chat: async (system, history, input) => {
    calls.push({ system, history, input });
    return "大家讨论了测试计划。";
  } };
  const config = { observation: {
    enabled: true, allGroups: false, groups: ["9"], analysisIntervalMinutes: 60,
    retentionDays: 30, minMessages: 2, maxMessagesPerAnalysis: 100,
  } };
  const observer = new GroupObserver(config, store, llm);
  try {
    await observer.start();
    assert.equal(await observer.observe(groupMessage("10", "不应保存")), false);
    assert.equal(await observer.observe(groupMessage("9", "第一条")), true);
    assert.equal(await observer.observe(groupMessage("9", "第二条", "8")), true);

    const messages = await store.messages("9");
    assert.equal(messages.length, 2);
    assert.equal(messages[0].content, "第一条");
    assert.deepEqual(await store.groupIds(), ["9"]);
    assert.equal((await store.groupStats())[0].messageCount, 2);

    const results = await observer.runAnalysis();
    assert.equal(results[0].status, "completed");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].history, []);
    assert.match(calls[0].input, /Alice：第一条/);
    assert.equal((await store.summaries("9"))[0].summary, "大家讨论了测试计划。");
  } finally {
    observer.stop();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
