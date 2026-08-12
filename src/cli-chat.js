import readline from "node:readline/promises";
import process from "node:process";
import { loadConfig } from "./config.js";

const config = loadConfig();
const configuredHost = config.webui.host;
const host = ["0.0.0.0", "::"].includes(configuredHost) ? "127.0.0.1" : configuredHost;
const baseUrl = `http://${host}:${config.webui.port}`;

async function api(path, options = {}) {
  const headers = new Headers(options.headers);
  if (config.webui.accessToken) headers.set("authorization", `Bearer ${config.webui.accessToken}`);
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  } catch (error) {
    throw new Error(`无法连接本地机器人服务 ${baseUrl}，请先运行 npm start`, { cause: error });
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

async function send(message, sessionId, transient = false) {
  return api("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel: "cli", sessionId, message, transient }),
  });
}

async function oneShot(args) {
  const message = args.join(" ").trim();
  if (!message) throw new Error('用法：npm run ask -- "你的问题"');
  const result = await send(message, `ask-${Date.now()}`, true);
  console.log(result.answer);
}

async function repl() {
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  let sessionId = "default";
  console.log(`${config.bot.name} 本地对话`);
  console.log("命令：/new 新会话，/reset 重置当前会话，/exit 退出\n");
  try {
    while (true) {
      const input = (await terminal.question("你> ")).trim();
      if (!input) continue;
      if (["/exit", "/quit"].includes(input.toLowerCase())) break;
      if (input.toLowerCase() === "/new") {
        sessionId = `repl-${Date.now()}`;
        console.log(`已创建新会话 ${sessionId}\n`);
        continue;
      }
      if (input.toLowerCase() === "/reset") {
        await api(`/api/chat/cli/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
        console.log("当前会话已重置\n");
        continue;
      }
      const result = await send(input, sessionId);
      console.log(`${config.bot.name}> ${result.answer}\n`);
    }
  } finally {
    terminal.close();
  }
}

const args = process.argv.slice(2);
(args[0] === "--ask" ? oneShot(args.slice(1)) : repl()).catch((error) => {
  console.error(`错误：${error.message}`);
  process.exit(1);
});
