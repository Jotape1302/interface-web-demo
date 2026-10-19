import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createEventHub } from "../src/events.js";

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  while (!buffer.includes(needle)) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  return buffer;
}

test("eventos chegam só para os usuários-alvo, com headers de SSE para o NGINX", async (t) => {
  const hub = createEventHub();
  const server = createServer((req, res) => {
    const userId = Number(new URL(req.url ?? "/", "http://x").searchParams.get("user"));
    hub.attach(userId, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    hub.closeAll();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;

  const res1 = await fetch(`${base}/?user=1`);
  const res2 = await fetch(`${base}/?user=2`);
  assert.equal(res1.headers.get("content-type"), "text/event-stream; charset=utf-8");
  assert.equal(res1.headers.get("x-accel-buffering"), "no");
  const r1 = res1.body!.getReader();
  const r2 = res2.body!.getReader();
  await readUntil(r1, "event: ready");
  await readUntil(r2, "event: ready");
  assert.equal(hub.connectionCount(), 2);

  hub.publish(1, "chat");
  hub.publish("all", "incidents");
  assert.match(await readUntil(r1, "event: incidents"), /event: chat[\s\S]*event: incidents/);
  const r2Buffer = await readUntil(r2, "event: incidents");
  assert.doesNotMatch(r2Buffer, /event: chat/);

  await r1.cancel();
  await r2.cancel();
  // A conexão encerrada pelo cliente sai do hub.
  for (let i = 0; i < 50 && hub.connectionCount() > 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(hub.connectionCount(), 0);
});
