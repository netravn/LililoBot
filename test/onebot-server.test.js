import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import WebSocket from "ws";
import { OneBotServer } from "../src/platform/onebot/server.js";

test("accepts an authenticated reverse WebSocket and dispatches events", async () => {
  let received;
  const eventReceived = new Promise((resolve) => {
    received = resolve;
  });
  const server = new OneBotServer(
    { host: "127.0.0.1", port: 0, path: "/ws", accessToken: "test-secret" },
    (connection, event) => received({ connection, event }),
  );
  const websocketServer = server.start();
  await once(websocketServer, "listening");
  const port = websocketServer.address().port;
  const client = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: {
      authorization: "Bearer test-secret",
      "x-self-id": "42",
    },
  });
  await once(client, "open");
  client.send(JSON.stringify({ post_type: "message", self_id: 42, message: "hello" }));
  const dispatched = await eventReceived;
  assert.equal(dispatched.connection.selfId, "42");
  assert.equal(dispatched.event.message, "hello");

  const apiFrameReceived = once(client, "message");
  const apiCall = dispatched.connection.call("send_group_msg", {
    group_id: 9,
    message: [{ type: "text", data: { text: "world" } }],
  });
  const [apiData] = await apiFrameReceived;
  const apiFrame = JSON.parse(apiData.toString());
  assert.equal(apiFrame.action, "send_group_msg");
  assert.equal(apiFrame.params.message[0].data.text, "world");
  client.send(
    JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 12 }, echo: apiFrame.echo }),
  );
  assert.deepEqual(await apiCall, { message_id: 12 });

  client.close();
  await once(client, "close");
  await server.stop();
});

test("replaces duplicate accounts and closes stale connections", async () => {
  const server = new OneBotServer(
    {
      host: "127.0.0.1", port: 0, path: "/ws", accessToken: "test-secret",
      heartbeatTimeoutMs: 100, healthCheckIntervalMs: 60_000,
    },
    () => {},
  );
  const websocketServer = server.start();
  await once(websocketServer, "listening");
  const url = `ws://127.0.0.1:${websocketServer.address().port}/ws`;
  const options = { headers: { authorization: "Bearer test-secret", "x-self-id": "42" } };
  const first = new WebSocket(url, options);
  await once(first, "open");
  const firstClosed = once(first, "close");
  const second = new WebSocket(url, options);
  await once(second, "open");
  const [closeCode] = await firstClosed;
  assert.equal(closeCode, 4001);

  second.send(JSON.stringify({
    post_type: "meta_event", meta_event_type: "heartbeat", self_id: 42,
  }));
  await new Promise((resolve) => setImmediate(resolve));
  const status = server.status();
  assert.deepEqual(status.connectedAccounts, ["42"]);
  assert.equal(status.accounts.length, 1);
  assert.ok(status.accounts[0].lastHeartbeatAt);

  const secondClosed = once(second, "close");
  server.checkHealth(Date.now() + 1_000);
  await secondClosed;
  assert.deepEqual(server.status().connectedAccounts, []);
  await server.stop();
});
