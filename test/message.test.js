import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSegments, parseInboundMessage, sessionKey } from "../src/core/message.js";

test("parses OneBot array messages", () => {
  const message = parseInboundMessage({
    post_type: "message",
    message_type: "group",
    self_id: 42,
    user_id: 7,
    group_id: 9,
    message_id: 11,
    sender: { card: "Alice" },
    message: [
      { type: "at", data: { qq: "42" } },
      { type: "text", data: { text: " 你好" } },
      { type: "image", data: { url: "https://example.test/a.png" } },
    ],
  });
  assert.equal(message.text, "你好");
  assert.deepEqual(message.mentions, ["42"]);
  assert.deepEqual(message.images, ["https://example.test/a.png"]);
  assert.equal(sessionKey(message), "onebot:42:group:9");
});

test("parses CQ-code string messages", () => {
  const segments = normalizeSegments("[CQ:reply,id=1][CQ:at,qq=42] hello&#91;x&#93;");
  assert.equal(segments[0].type, "reply");
  assert.equal(segments[1].data.qq, "42");
  assert.equal(segments[2].data.text, " hello[x]");
});
