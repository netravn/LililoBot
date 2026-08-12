import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { OpenAiClient, ModelRequestError } from "../src/services/openai-client.js";

async function mockProvider(status, body) {
  const server = http.createServer((_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

test("OpenAiClient classifies provider rate limits", async () => {
  const server = await mockProvider(429, { error: { message: "rate limit exceeded" } });
  try {
    const port = server.address().port;
    const client = new OpenAiClient({
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: "test",
      model: "test-model",
      temperature: 0.7,
      timeoutMs: 1000,
    });
    await assert.rejects(
      client.chat("system", [], "hello"),
      (error) => error instanceof ModelRequestError
        && error.code === "model_rate_limited"
        && error.statusCode === 429,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("OpenAiClient reports missing configuration", async () => {
  const client = new OpenAiClient({ apiKey: "" });
  await assert.rejects(
    client.chat("system", [], "hello"),
    (error) => error.code === "model_not_configured" && error.statusCode === 503,
  );
});
