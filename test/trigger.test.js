import test from "node:test";
import assert from "node:assert/strict";
import { decideTrigger } from "../src/core/trigger.js";

const config = {
  qq: {
    allowPrivate: true,
    privateAllowlist: ["7"],
    allowedGroups: ["9"],
    groupKeywords: ["莉莉洛"],
  },
};

test("accepts allowed private messages", () => {
  assert.equal(
    decideTrigger({ kind: "private", senderId: "7", selfId: "42", text: "hello" }, config)
      .accepted,
    true,
  );
});

test("requires mention or keyword in allowed groups", () => {
  const base = {
    kind: "group",
    senderId: "7",
    selfId: "42",
    conversationId: "9",
    mentions: [],
    text: "hello",
  };
  assert.equal(decideTrigger(base, config).accepted, false);
  assert.equal(decideTrigger({ ...base, mentions: ["42"] }, config).accepted, true);
  assert.deepEqual(decideTrigger({ ...base, text: "莉莉洛 你好" }, config), {
    accepted: true,
    content: "你好",
    reason: "keyword",
  });
});
