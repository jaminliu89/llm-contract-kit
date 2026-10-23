import { ContractError, ERR } from "./errors.mjs";
import { buildItemPrompt, buildDecisionPrompt } from "./prompt.mjs";
import { normalizeItems, normalizeDecision, parseLooseJson, buildRepairPrompt } from "./validate.mjs";

const NON_REPAIRABLE = new Set([
  ERR.CONFIG_INVALID,
  ERR.CLI_UNAVAILABLE,
  ERR.UPSTREAM_HTTP,
  ERR.UPSTREAM_TIMEOUT,
]);

function appendRepair(prompt, repair) {
  return `${prompt}\n\n---\n\n${repair}`;
}

export async function generateWithContract({
  contract,
  context = {},
  provider,
  maxRepairs = 2,
  systemPrompt = undefined,
}) {
  if (typeof provider?.text !== "function") {
    throw new ContractError(ERR.CONFIG_INVALID, "provider.text(prompt) 必须是一个可调用函数。", 400);
  }

  const basePrompt = buildItemPrompt(contract, context);
  const trace = [];
  let prompt = basePrompt;
  let lastError;

  for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
    const response = await provider.text({ prompt, systemPrompt, attempt });

    try {
      const parsed = parseLooseJson(response.raw);
      const items = normalizeItems(contract, parsed, context);
      trace.push({ attempt, ok: true });
      return {
        ok: true,
        items,
        attempts: attempt + 1,
        trace,
        raw: response.raw,
        durationMs: response.durationMs,
        commandPreview: response.commandPreview,
      };
    } catch (error) {
      lastError = error;
      trace.push({ attempt, ok: false, code: error.code, message: error.message });

      if (!(error instanceof ContractError)) throw error;
      if (NON_REPAIRABLE.has(error.code)) throw error;
      if (attempt === maxRepairs) break;

      prompt = appendRepair(basePrompt, buildRepairPrompt(contract, error, response.raw));
    }
  }

  throw new ContractError(
    lastError?.code ?? ERR.BAD_JSON,
    `${lastError?.message ?? "输出未通过校验。"}（已自动重试 ${maxRepairs} 次仍不合规）`,
    lastError?.status ?? 502,
    { attempts: maxRepairs + 1, trace },
  );
}

export async function decideWithContract({
  decision,
  options,
  context = {},
  provider,
  maxRepairs = 1,
  systemPrompt = undefined,
}) {
  if (!Array.isArray(options) || options.length === 0) {
    throw new ContractError(ERR.BAD_REQUEST, "决策需要至少一个候选项。", 400);
  }
  const seen = new Set();
  for (const option of options) {
    const id = typeof option?.id === "string" ? option.id.trim() : "";
    if (!id) throw new ContractError(ERR.BAD_REQUEST, "每个候选项都必须有非空字符串 id。", 400);
    if (seen.has(id)) throw new ContractError(ERR.BAD_REQUEST, `候选项 id 重复：${id}。`, 400);
    seen.add(id);
  }

  const basePrompt = buildDecisionPrompt(decision, options, context);
  const trace = [];
  let prompt = basePrompt;
  let lastError;

  for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
    const response = await provider.text({ prompt, systemPrompt, attempt });

    try {
      const parsed = parseLooseJson(response.raw);
      const result = normalizeDecision(decision, parsed, options);
      trace.push({ attempt, ok: true });
      return {
        ok: true,
        ...result,
        attempts: attempt + 1,
        trace,
        raw: response.raw,
        durationMs: response.durationMs,
      };
    } catch (error) {
      lastError = error;
      trace.push({ attempt, ok: false, code: error.code, message: error.message });
      if (!(error instanceof ContractError)) throw error;
      if (NON_REPAIRABLE.has(error.code)) throw error;
      if (attempt === maxRepairs) break;

      prompt = appendRepair(
        basePrompt,
        [
          "你上一次的决策没有通过校验。",
          "",
          `失败原因：${error.message}`,
          `可用的候选 id：${options.map((option) => option.id).join(", ")}`,
          "",
          '只返回 {"selectedIds":["..."],"reason":"..."}，id 必须来自上面的列表。',
        ].join("\n"),
      );
    }
  }

  throw new ContractError(
    lastError?.code ?? ERR.BAD_DECISION,
    `${lastError?.message ?? "决策未通过校验。"}（已自动重试 ${maxRepairs} 次）`,
    lastError?.status ?? 502,
    { attempts: maxRepairs + 1, trace },
  );
}
