import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ToolRegistry } from "../src/tools/registry.js";
import { registerScripts } from "../src/tools/scripts.js";

test("registered scripts receive validated arguments without a shell", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lililo-scripts-"));
  const directory = path.join(projectRoot, "tools", "scripts");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "report.sh"), "#!/bin/sh\nprintf '%s' \"$1\"\n");
  await fs.chmod(path.join(directory, "report.sh"), 0o700);
  await fs.writeFile(path.join(directory, "index.json"), JSON.stringify({ scripts: [{
    name: "report",
    description: "report",
    file: "report.sh",
    arguments: [{ name: "value", type: "string", required: true }],
  }] }));
  const registry = new ToolRegistry();
  try {
    await registerScripts(registry, {
      enabled: true, directory: "tools/scripts", allowQqAdminPrivate: false,
      timeoutMs: 1000, maxOutputBytes: 1000,
    }, projectRoot);
    assert.equal(registry.definitions({ channel: "qq", kind: "private", isAdmin: true }).length, 0);
    const output = JSON.parse(await registry.execute("run_report", { value: "hello; uname" }, { channel: "web" }));
    assert.equal(output.output, "hello; uname");
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});
