import { ContractError, ERR } from "../errors.mjs";
import { sanitizeDetails } from "../redact.mjs";
import { JSON_ONLY_RULES } from "../prompt.mjs";

const CHAT_ENDPOINT = "/chat/completions";
const DEFAULT_TIMEOUT_MS = 120_000;

function isOfficialKimi(baseUrl) {
  try {
    const url = new URL(baseUrl);
    return (
      url.hostname === "api.moonshot.cn" ||
      url.hostname === "api.moonshot.ai" ||
      (url.hostname === "api.kimi.com" && /^\/coding(?:\/|$)/i.test(url.pathname))
    );
  } catch {
    return false;
  }
}

export function requireCloudConfig(payload = {}) {
  const apiKey = String(payload.apiKey ?? "").trim();
  const baseUrl = String(payload.baseUrl ?? "").trim();
  const model = String(payload.model ?? "").trim();

  if (!apiKey) throw new ContractError(ERR.CONFIG_INVALID, "缺少 API Key。", 400);
  if (!baseUrl) throw new ContractError(ERR.CONFIG_INVALID, "缺少 API Base URL。", 400);
  if (!model) throw new ContractError(ERR.CONFIG_INVALID, "缺少模型名称。", 400);

  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ContractError(ERR.CONFIG_INVALID, "API Base URL 不是合法 URL。", 400);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new ContractError(ERR.CONFIG_INVALID, "API Base URL 只支持 http 或 https。", 400);
  }
  return { apiKey, baseUrl, model };
}

export function buildChatBody({ model, prompt, baseUrl, systemPrompt, temperature, maxTokens = 4096 }) {
  const kimi = isOfficialKimi(baseUrl);
  const messages = [
    ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
    { role: "user", content: prompt },
  ];

  const body = {
    model,
    messages,
    response_format: { type: "json_object" },
    stream: false,
  };

  if (kimi) {
    body.max_completion_tokens = maxTokens;
  } else {
    body.max_tokens = maxTokens;
    if (typeof temperature === "number") body.temperature = temperature;
  }

  return body;
}

export function buildHttpError({ status, text, apiKey }) {
  let reason = "";
  try {
    const parsed = JSON.parse(text);
    reason = parsed?.error?.message || parsed?.message || parsed?.error || "";
    if (typeof reason === "object") reason = JSON.stringify(reason);
  } catch {
    reason = String(text ?? "").slice(0, 400);
  }
  const safe = sanitizeDetails(reason, apiKey);
  return new ContractError(
    ERR.UPSTREAM_HTTP,
    `上游 API 返回 ${status}${safe ? `：${safe}` : "。"}`,
    status >= 400 && status < 500 ? 400 : 502,
    safe,
  );
}

export async function runCloudText({ prompt, apiKey, baseUrl, model, systemPrompt, temperature, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const url = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const endpoint = new URL(CHAT_ENDPOINT.replace(/^\//, ""), url).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(buildChatBody({ model, prompt, baseUrl, systemPrompt, temperature })),
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      throw buildHttpError({ status: response.status, text, apiKey });
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new ContractError(
        ERR.BAD_JSON,
        "上游返回的不是 JSON。请确认 Base URL 指向 OpenAI-compatible 接口。",
        502,
        sanitizeDetails(text, apiKey),
      );
    }

    const raw = data?.choices?.[0]?.message?.content;
    if (typeof raw !== "string" || !raw.trim()) {
      throw new ContractError(
        ERR.BAD_JSON,
        "上游响应里没有 choices[0].message.content。请确认模型支持 chat completions。",
        502,
        sanitizeDetails(JSON.stringify(data).slice(0, 400), apiKey),
      );
    }

    return { raw: raw.trim(), durationMs: Date.now() - startedAt, commandPreview: `POST ${endpoint}`, usage: data?.usage };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new ContractError(ERR.UPSTREAM_TIMEOUT, `上游请求超过 ${Math.round(timeoutMs / 1000)}s 未返回。`, 504);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export { JSON_ONLY_RULES, isOfficialKimi };
