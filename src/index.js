import { loadConfig } from "./config.js";
import { Bot } from "./core/bot.js";
import { AgentRuntime } from "./core/agent-runtime.js";
import { Logger } from "./core/logger.js";
import { OneBotServer } from "./platform/onebot/server.js";
import { OpenAiClient } from "./services/openai-client.js";
import { ConversationStore } from "./store/conversation-store.js";
import { WebUiServer } from "./webui/server.js";

async function main() {
  const config = loadConfig();
  const logger = new Logger();
  const store = new ConversationStore(config.storage.sessionsDir, config.bot.maxHistoryTurns);
  await store.init();
  const agent = new AgentRuntime(config, store, new OpenAiClient(config.llm), logger);
  await agent.init();
  const bot = new Bot(config, agent, logger);
  const server = new OneBotServer(
    config.onebot,
    (connection, event) => bot.handleOneBotEvent(connection, event),
    logger,
  );
  server.start();
  const webui = config.webui.enabled
    ? new WebUiServer(config, { store, onebot: server, agent, logger })
    : null;
  webui?.start();

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    logger.info("app", "shutting down");
    await Promise.all([server.stop(), webui?.stop()]);
  };
  process.on("SIGINT", () => shutdown().then(() => process.exit(0)));
  process.on("SIGTERM", () => shutdown().then(() => process.exit(0)));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
