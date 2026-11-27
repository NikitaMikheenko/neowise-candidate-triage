import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { classify } from "./mock-ai.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));
const allowedTopics = new Set(["delivery", "pricing", "other"]);
const manualReview = { status: "manual_review", topic: null, draft: null };

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function handleTriage(request, response) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);

  let text;
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    text = input?.text;
  } catch {
    return json(response, 400, { status: "invalid_input" });
  }
  if (typeof text !== "string" || !text.trim()) {
    return json(response, 400, { status: "invalid_input" });
  }

  let result;
  try {
    const output = await classify(text, { signal: AbortSignal.timeout(300) });
    result = JSON.parse(output);
  } catch {
    return json(response, 200, manualReview);
  }

  const { topic, draft } = result ?? {};
  if (!allowedTopics.has(topic) || typeof draft !== "string" || !draft.trim()) {
    return json(response, 200, manualReview);
  }
  return json(response, 200, { status: "ready", topic, draft });
}

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(html);
    return;
  }
  if (request.method !== "POST" || request.url !== "/api/triage") {
    return json(response, 404, { status: "not_found" });
  }
  try {
    await handleTriage(request, response);
  } catch {
    json(response, 500, { status: "server_error" });
  }
});

server.listen(Number(process.env.PORT || 3000), "127.0.0.1", () => {
  process.send?.({ port: server.address().port });
});
