// Mock OpenAI-compatible server: fail with HTTP 500 for the first N requests, then succeed.
import http from "node:http";

const FAIL_TIMES = Number(process.argv[2] ?? 8);
const PORT = Number(process.argv[3] ?? 59321);
let hits = 0;

const chunks = (model) => [
  { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: "pong" }, finish_reason: null }] },
  { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
];

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    hits++;
    const n = hits;
    if (n <= FAIL_TIMES) {
      console.log(`req #${n} -> 500`);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "flaky", code: "server_error" } }));
      return;
    }
    console.log(`req #${n} -> 200 (stream=${body.includes('"stream":true')})`);
    let model = "test";
    try { model = JSON.parse(body).model ?? model; } catch {}
    if (body.includes('"stream":true')) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const c of chunks(model)) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl-1", object: "chat.completion", created: 1, model,
        choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }));
    }
  });
});

server.listen(PORT, "127.0.0.1", () => console.log(`flaky mock on 127.0.0.1:${PORT}, failing first ${FAIL_TIMES} requests`));
