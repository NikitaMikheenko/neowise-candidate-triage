import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const host = "127.0.0.1";
const manualReview = { status: "manual_review", topic: null, draft: null };

let child;
let baseUrl;

before(async () => {
  child = fork(fileURLToPath(new URL("./server.mjs", import.meta.url)), [], {
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let startupError = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { startupError += chunk; });

  const signal = AbortSignal.timeout(3_000);
  const [{ port }] = await Promise.race([
    once(child, "message", { signal }),
    once(child, "close", { signal }).then(([code]) => {
      throw new Error(`Test server exited before listening (code ${code})\n${startupError}`);
    }),
  ]);
  assert.ok(Number.isInteger(port) && port > 0, "Expected an assigned test server port");
  baseUrl = `http://${host}:${port}`;
  const response = await fetch(baseUrl, { signal });
  await response.text();
  assert.equal(response.status, 200);
});

after(async () => {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const stopped = once(child, "exit");
  child.kill();
  await stopped;
});

async function postTriage(body) {
  const response = await fetch(`${baseUrl}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(3_000),
  });
  return { status: response.status, body: await response.json() };
}

for (const [text, topic] of [
  ["Когда будет доставка?", "delivery"],
  ["Подскажите цену", "pricing"],
  ["Хочу уточнить график работы", "other"],
]) {
  test(`returns a ready draft for topic ${topic}`, async () => {
    const { status, body } = await postTriage(JSON.stringify({ text }));
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body).sort(), ["draft", "status", "topic"]);
    assert.equal(body.status, "ready");
    assert.equal(body.topic, topic);
    assert.equal(typeof body.draft, "string");
    assert.ok(body.draft.trim());
  });
}

for (const [label, body] of [
  ["empty text", JSON.stringify({ text: "" })],
  ["whitespace-only text", JSON.stringify({ text: " \t\n" })],
  ["missing text", "{}"],
  ["null text", JSON.stringify({ text: null })],
  ["numeric text", JSON.stringify({ text: 42 })],
  ["array text", JSON.stringify({ text: ["Доставка"] })],
  ["object text", JSON.stringify({ text: { value: "Доставка" } })],
  ["null request", "null"],
  ["broken JSON", '{"text":'],
]) {
  test(`returns invalid_input for ${label}`, async () => {
    assert.deepEqual(await postTriage(body), {
      status: 400,
      body: { status: "invalid_input" },
    });
  });
}

for (const marker of ["[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
  test(`returns manual_review for ${marker}`, async () => {
    assert.deepEqual(await postTriage(JSON.stringify({ text: marker })), {
      status: 200,
      body: manualReview,
    });
  });
}

test("times out before the slow model finishes", async () => {
  const started = performance.now();
  const response = await postTriage(JSON.stringify({ text: "[timeout]" }));
  const elapsed = performance.now() - started;
  assert.deepEqual(response, { status: 200, body: manualReview });
  assert.ok(elapsed < 900, `Expected a timeout response before 900 ms, got ${Math.round(elapsed)} ms`);
});
