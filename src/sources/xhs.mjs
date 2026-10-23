import { spawnCollect } from "../providers/cli.mjs";
import { ContractError, ERR } from "../errors.mjs";
import { sanitizeDetails } from "../redact.mjs";

const DEFAULT_COMMAND = "xhs";
const TIMEOUT_MS = 90_000;
const VALID_SORTS = new Set(["general", "popular", "latest"]);
const VALID_TYPES = new Set(["all", "video", "image"]);

function clip(value, max = 180) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function pickString(source, keys) {
  if (!source || typeof source !== "object") return "";
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function formatCount(value) {
  const num = typeof value === "number" ? value : Number(String(value ?? "").replace(/,/g, ""));
  if (!Number.isFinite(num)) return String(value ?? "").trim();
  if (num >= 100_000_000) return `${(num / 100_000_000).toFixed(1)}亿`;
  if (num >= 10_000) return `${(num / 10_000).toFixed(1)}万`;
  return String(num);
}

function formatMetrics(interact = {}) {
  const parts = [];
  const liked = pickString(interact, ["liked_count", "liked", "likes"]);
  const collected = pickString(interact, ["collected_count", "collected", "collects"]);
  const comments = pickString(interact, ["comment_count", "comments"]);
  if (liked) parts.push(`赞 ${formatCount(liked)}`);
  if (collected) parts.push(`藏 ${formatCount(collected)}`);
  if (comments) parts.push(`评 ${formatCount(comments)}`);
  return parts.length ? parts.join(" | ") : "互动数据暂未返回";
}

function normalizeTags(card) {
  const raw = [card?.tag_list, card?.tags, card?.topic_list].find(Array.isArray) ?? [];
  return raw
    .map((tag) => (typeof tag === "string" ? tag.trim() : pickString(tag, ["name", "tag_name", "title", "text"])))
    .filter(Boolean)
    .slice(0, 8);
}

export function normalizeXhsItems(raw, { keyword = "", page = 1 } = {}) {
  const envelope = raw?.ok === undefined ? { ok: true, data: { items: Array.isArray(raw) ? raw : [] } } : raw;

  if (envelope.ok === false) {
    const code = String(envelope.error?.code ?? "");
    const details = sanitizeDetails(envelope.error?.details ?? envelope.error?.message ?? "");
    if (code === "not_authenticated") {
      throw new ContractError(
        "XHS_AUTH_REQUIRED",
        "小红书未登录。终端执行 `xhs login` 完成扫码后重试。",
        401,
        details,
      );
    }
    if (code === "verification_required") {
      throw new ContractError("XHS_VERIFY_REQUIRED", "小红书要求安全验证。浏览器打开小红书完成验证后重试。", 429, details);
    }
    if (code === "ip_blocked") {
      throw new ContractError("XHS_RATE_LIMITED", "当前网络或请求频率被限制，稍后换网络重试。", 429, details);
    }
    throw new ContractError("XHS_FAILED", envelope.error?.message ?? "xhs 搜索失败。", 502, details);
  }

  const items = Array.isArray(envelope?.data?.items) ? envelope.data.items : [];

  return items
    .map((item, index) => {
      const card = item?.note_card ?? item;
      const user = card?.user ?? card?.user_info ?? {};
      const noteId = pickString(item, ["id", "note_id"]) || pickString(card, ["note_id", "id"]);
      const title =
        clip(pickString(card, ["title", "display_title", "name"])) || `搜索结果 ${page}-${index + 1}`;
      const excerpt = clip(
        pickString(card, ["desc", "description", "content", "summary"]) || title,
        220,
      );
      const rawType = pickString(card, ["type", "note_type"]);
      return {
        id: `xhs-${page}-${index + 1}-${noteId || "unknown"}`,
        noteId,
        title,
        excerpt,
        tags: normalizeTags(card),
        metrics: formatMetrics(card?.interact_info ?? {}),
        author: clip(pickString(user, ["nickname", "nick_name", "name"]) || "未知作者", 40),
        noteType: /video/i.test(rawType) ? "video" : "image",
        keyword,
      };
    })
    .filter((item) => item.title || item.noteId);
}

export function validateXhsQuery(payload = {}) {
  const keyword = String(payload.keyword ?? "").trim();
  if (!keyword) throw new ContractError(ERR.BAD_REQUEST, "请提供搜索关键词。", 400);
  const sort = String(payload.sort ?? "popular").trim();
  if (!VALID_SORTS.has(sort)) {
    throw new ContractError(ERR.BAD_REQUEST, `排序无效，可选：${[...VALID_SORTS].join(", ")}。`, 400);
  }
  const type = String(payload.type ?? "all").trim();
  if (!VALID_TYPES.has(type)) {
    throw new ContractError(ERR.BAD_REQUEST, `类型无效，可选：${[...VALID_TYPES].join(", ")}。`, 400);
  }
  return { keyword, sort, type };
}

function diagnoseXhsOutput(text) {
  const body = String(text ?? "");
  if (/manifest\.json is missing|official\/stable is not installed|failed to download and extract ubo/i.test(body)) {
    return new ContractError(
      "XHS_CLI_BROKEN",
      "xhs CLI 的内部浏览器依赖没装好（camoufox / uBlock Origin）。终端执行 `camoufox fetch` 后重试。",
      503,
      sanitizeDetails(body),
    );
  }
  if (/search\.feeds not ready/i.test(body)) {
    return new ContractError(
      "XHS_FEEDS_MISSING",
      "浏览器起来了但搜索页没吐出 feed 数据。三个常见原因：登录态过期（xhs status 可能仍显示已登录）、命中风控跳了验证页、小红书前端改了 __INITIAL_STATE__ 结构。先用 `xhs whoami` 确认身份，或用 --refs-file 直接提供参考内容绕开抓取。",
      502,
      sanitizeDetails(body),
    );
  }
  if (/not.?logged|login required|please login|未登录/i.test(body)) {
    return new ContractError("XHS_AUTH_REQUIRED", "小红书未登录或登录已失效。终端执行 `xhs login` 扫码后重试。", 401, sanitizeDetails(body));
  }
  return null;
}

export async function runXhsSearch(payload = {}, options = {}) {
  const { keyword, sort, type } = validateXhsQuery(payload);
  const command = options.command ?? process.env.XHS_CLI_COMMAND ?? DEFAULT_COMMAND;

  const args = ["search", keyword, "--json"];

  let result;
  try {
    result = await spawnCollect(command, args, { timeoutMs: options.timeoutMs ?? TIMEOUT_MS, label: "xhs CLI" });
  } catch (error) {
    const message = String(error?.message ?? "");
    if (/ENOENT/.test(message) || error?.code === ERR.CLI_UNAVAILABLE) {
      throw new ContractError(
        "XHS_CLI_MISSING",
        "未找到 xhs CLI。安装：pipx install xhs-cli，或设置 XHS_CLI_COMMAND 指向可执行文件。",
        503,
        message,
      );
    }
    const diagnosed = diagnoseXhsOutput(`${message}\n${error?.details ?? ""}`);
    if (diagnosed) throw diagnosed;
    throw error;
  }

  const diagnosed = diagnoseXhsOutput(result.stdout);
  if (diagnosed) throw diagnosed;

  const stdout = result.stdout;
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    const start = stdout.indexOf("{");
    const end = stdout.lastIndexOf("}");
    if (start >= 0 && end > start) {
      parsed = JSON.parse(stdout.slice(start, end + 1));
    } else {
      throw new ContractError("XHS_BAD_JSON", "xhs CLI 输出不是合法 JSON。", 502, sanitizeDetails(stdout));
    }
  }

  const items = normalizeXhsItems(parsed, { keyword, page: Number(payload.page ?? 1) });
  return {
    items,
    estimatedTotal: items.length,
    meta: { keyword, sort, type, command: `${command} search [keyword] --json` },
    durationMs: result.durationMs,
  };
}
