import { toHttpBody, ContractError, ERR } from "./errors.mjs";

const MAX_BODY_BYTES = 128 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk.toString("utf8");
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
      throw new ContractError(ERR.BAD_REQUEST, `请求体超过 ${Math.round(MAX_BODY_BYTES / 1024)}KB 上限。`, 413);
    }
  }
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new ContractError(ERR.BAD_REQUEST, "请求体不是合法 JSON。", 400);
  }
}

function parseHostHeader(req) {
  const raw = String(req.headers.host ?? "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.startsWith("[")) return raw.slice(0, raw.indexOf("]") + 1);
  return raw.split(":")[0];
}

export function assertLoopbackOnly(req) {
  const host = parseHostHeader(req);
  if (host && !LOOPBACK_HOSTS.has(host)) {
    throw new ContractError(
      ERR.BAD_REQUEST,
      `拒绝非本机 Host：${host}。该服务只接受 127.0.0.1 / localhost，用于阻断 DNS rebinding。`,
      403,
    );
  }

  const origin = req.headers.origin;
  if (!origin) return;

  let originHost;
  try {
    originHost = new URL(origin).hostname.toLowerCase();
  } catch {
    throw new ContractError(ERR.BAD_REQUEST, `Origin 不是合法 URL：${origin}。`, 403);
  }

  if (!LOOPBACK_HOSTS.has(originHost)) {
    throw new ContractError(ERR.BAD_REQUEST, `拒绝跨站来源：${origin}。`, 403);
  }
}

export function createContractRouter(routes, options = {}) {
  const { prefix = "/api", requireToken = undefined, onError = undefined } = options;
  const table = new Map(Object.entries(routes).map(([key, handler]) => [`${prefix}${key}`, handler]));

  return async function contractMiddleware(req, res, next) {
    const requestUrl = new URL(req.url ?? "/", "http://localhost");
    const handler = table.get(requestUrl.pathname);
    if (!handler) {
      if (typeof next === "function") next();
      return;
    }

    try {
      assertLoopbackOnly(req);
    } catch (error) {
      const { status, body } = toHttpBody(error);
      sendJson(res, status, body);
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, code: "METHOD_NOT_ALLOWED", error: "只接受 POST。" });
      return;
    }

    if (requireToken && req.headers["x-contract-token"] !== requireToken) {
      sendJson(res, 401, { ok: false, code: "UNAUTHORIZED", error: "缺少或错误的 x-contract-token。" });
      return;
    }

    try {
      const payload = await readJsonBody(req);
      const result = await handler(payload, { req, requestUrl });
      sendJson(res, 200, { ok: true, ...result, generatedAt: new Date().toISOString() });
    } catch (error) {
      if (typeof onError === "function") onError(error);
      const { status, body } = toHttpBody(error);
      sendJson(res, status, body);
    }
  };
}

export function vitePluginContractApi({ routes, prefix = "/api", requireToken } = {}) {
  const middleware = createContractRouter(routes, { prefix, requireToken });
  return {
    name: "contract-api",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
