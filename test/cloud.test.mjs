import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { runCloudText, buildChatBody, isOfficialKimi, buildHttpError } from "../src/providers/openai.mjs";

function startStub(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/v1` });
    });
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
  });
}

test("真实 HTTP 往返：路径拼接、鉴权头、响应解析", async () => {
  let captured;
  const { server, baseUrl } = await startStub(async (req, res) => {
    captured = { url: req.url, auth: req.headers.authorization, body: JSON.parse(await readBody(req)) };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: '{"items":[]}' } }], usage: { total_tokens: 12 } }));
  });

  try {
    const result = await runCloudText({ prompt: "hi", apiKey: "sk-test-123456", baseUrl, model: "gpt-4o-mini" });
    assert.equal(captured.url, "/v1/chat/completions");
    assert.equal(captured.auth, "Bearer sk-test-123456");
    assert.equal(captured.body.model, "gpt-4o-mini");
    assert.equal(captured.body.response_format.type, "json_object");
    assert.match(result.raw, /items/);
    assert.equal(result.usage.total_tokens, 12);
    assert.ok(result.durationMs >= 0);
  } finally {
    server.close();
  }
});

test("baseUrl 带尾斜杠也不产生双斜杠", async () => {
  let path;
  const { server, baseUrl } = await startStub(async (req, res) => {
    path = req.url;
    res.writeHead(200);
    res.end(JSON.stringify({ choices: [{ message: { content: "{}" } }] }));
  });
  try {
    await runCloudText({ prompt: "hi", apiKey: "k-123456", baseUrl: `${baseUrl}/`, model: "m" });
    assert.equal(path, "/v1/chat/completions");
  } finally {
    server.close();
  }
});

test("上游 4xx 保留状态码与原因，且不回显 API Key", async () => {
  const { server, baseUrl } = await startStub(async (req, res) => {
    await readBody(req);
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "invalid api key: sk-secret-abcdef123456" } }));
  });
  try {
    await assert.rejects(
      () => runCloudText({ prompt: "hi", apiKey: "sk-secret-abcdef123456", baseUrl, model: "m" }),
      (error) => {
        assert.equal(error.code, "UPSTREAM_HTTP");
        assert.match(error.message, /401/);
        assert.doesNotMatch(error.message, /sk-secret-abcdef123456/);
        assert.match(error.message, /\[redacted\]/);
        return true;
      },
    );
  } finally {
    server.close();
  }
});

test("上游返回非 JSON 时报明确错误", async () => {
  const { server, baseUrl } = await startStub(async (req, res) => {
    await readBody(req);
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html>gateway error</html>");
  });
  try {
    await assert.rejects(
      () => runCloudText({ prompt: "hi", apiKey: "k-123456", baseUrl, model: "m" }),
      (error) => error.code === "LLM_BAD_JSON" && /OpenAI-compatible/.test(error.message),
    );
  } finally {
    server.close();
  }
});

test("响应缺 choices 时报错而不是静默返回空", async () => {
  const { server, baseUrl } = await startStub(async (req, res) => {
    await readBody(req);
    res.writeHead(200);
    res.end(JSON.stringify({ object: "list" }));
  });
  try {
    await assert.rejects(
      () => runCloudText({ prompt: "hi", apiKey: "k-123456", baseUrl, model: "m" }),
      (error) => error.code === "LLM_BAD_JSON" && /choices/.test(error.message),
    );
  } finally {
    server.close();
  }
});

test("超时中止并报 UPSTREAM_TIMEOUT", async () => {
  const { server, baseUrl } = await startStub(async () => {
    await new Promise(() => {});
  });
  try {
    await assert.rejects(
      () => runCloudText({ prompt: "hi", apiKey: "k-123456", baseUrl, model: "m", timeoutMs: 300 }),
      (error) => error.code === "UPSTREAM_TIMEOUT",
    );
  } finally {
    server.close();
  }
});

test("Kimi 官方接口：用 max_completion_tokens、不传 temperature", () => {
  for (const url of ["https://api.moonshot.cn/v1", "https://api.moonshot.ai/v1", "https://api.kimi.com/coding"]) {
    assert.equal(isOfficialKimi(url), true, url);
    const body = buildChatBody({ model: "kimi-k2", prompt: "p", baseUrl: url, temperature: 0.7 });
    assert.equal(body.max_completion_tokens, 4096);
    assert.equal(body.max_tokens, undefined);
    assert.equal(body.temperature, undefined);
  }
});

test("普通 OpenAI 兼容：用 max_tokens 且保留 temperature", () => {
  const body = buildChatBody({ model: "gpt-4o", prompt: "p", baseUrl: "https://api.openai.com/v1", temperature: 0.3 });
  assert.equal(body.max_tokens, 4096);
  assert.equal(body.temperature, 0.3);
  assert.equal(body.max_completion_tokens, undefined);
});

test("buildHttpError 对 5xx 归为 502、对 4xx 归为 400", () => {
  assert.equal(buildHttpError({ status: 500, text: "boom", apiKey: "k" }).status, 502);
  assert.equal(buildHttpError({ status: 429, text: "slow down", apiKey: "k" }).status, 400);
});
