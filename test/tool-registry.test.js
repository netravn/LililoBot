import test from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../src/tools/registry.js";

test("ToolRegistry hides local tools from QQ groups", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "local_status",
    description: "status",
    scopes: ["local", "qq-private-admin"],
    parameters: { type: "object", properties: {} },
    execute: async () => "ok",
  });
  assert.equal(registry.definitions({ channel: "qq", kind: "group", isAdmin: true }).length, 0);
  assert.equal(registry.definitions({ channel: "qq", kind: "private", isAdmin: true }).length, 1);
  assert.equal(registry.definitions({ channel: "web" }).length, 1);
});

test("ToolRegistry validates arguments before execution", async () => {
  const registry = new ToolRegistry();
  let executed = false;
  registry.register({
    name: "search",
    description: "search",
    scopes: ["all"],
    parameters: { type: "object", required: ["query"], properties: { query: { type: "string", maxLength: 10 } } },
    execute: async () => { executed = true; return "ok"; },
  });
  await assert.rejects(registry.execute("search", { query: 42 }, { channel: "qq", kind: "group" }), /必须是字符串/);
  assert.equal(executed, false);
});
