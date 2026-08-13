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

test("OpenAiClient sends tools and returns tool calls", async () => {
  let received;
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received = JSON.parse(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call-1", type: "function", function: { name: "status", arguments: "{}" } }],
    } }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const client = new OpenAiClient({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      apiKey: "test", model: "test-model", temperature: 0, timeoutMs: 1000,
    });
    const tools = [{ type: "function", function: { name: "status", parameters: { type: "object" } } }];
    const result = await client.complete([{ role: "user", content: "status" }], tools);
    assert.equal(result.tool_calls[0].function.name, "status");
    assert.deepEqual(received.tools, tools);
    assert.equal(received.tool_choice, "auto");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
