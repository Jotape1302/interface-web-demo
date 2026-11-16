import test from "node:test";
import assert from "node:assert/strict";
import { parseSseEvents } from "./realtime";

void test("extrai eventos completos e guarda o bloco incompleto", () => {
  const { events, rest } = parseSseEvents("retry: 5000\nevent: ready\ndata: {}\n\n: ping\n\nevent: chat\ndata: {}\n\nevent: noti");
  assert.deepEqual(events, ["ready", "chat"]);
  assert.equal(rest, "event: noti");
});

void test("aceita CRLF", () => {
  assert.deepEqual(parseSseEvents("event: incidents\r\ndata: {}\r\n\r\n").events, ["incidents"]);
});
