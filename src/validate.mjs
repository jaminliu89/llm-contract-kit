import { ContractError, ERR } from "./errors.mjs";

function pickAlias(item, field) {
  for (const key of field.aliases) {
    const value = item?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value) && value.length > 0) return value;
  }
  return undefined;
}

function clip(value, max) {
  const text = String(value);
  if (!max || text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function checkField(contractName, index, key, field, rawValue, ctx) {
  const where = `${contractName}[${index}].${key}`;
  let value = rawValue;

  if (value === undefined || value === null || value === "") {
    if (field.default !== undefined) {
      value = typeof field.default === "function" ? field.default(ctx, index) : field.default;
    } else if (field.required !== false) {
      throw new ContractError(
        ERR.BAD_FIELD,
        `字段缺失：${where}。模型没有返回该字段，或只返回了别名之外的名字。可接受的键名：${field.aliases.join(" / ")}。`,
        502,
        { where, acceptedKeys: field.aliases },
      );
    } else {
      return undefined;
    }
  }

  if (field.type === "string[]") {
    if (!Array.isArray(value)) {
      throw new ContractError(ERR.BAD_FIELD, `字段类型错误：${where} 必须是字符串数组，实际是 ${typeof value}。`, 502, { where });
    }
    value = value.map((entry) => (typeof entry === "string" ? entry.trim() : String(entry ?? "").trim())).filter(Boolean);
  } else {
    if (typeof value !== "string") value = String(value);
    value = value.trim();
  }

  const asText = Array.isArray(value) ? value.join("\n") : value;

  if (field.maxLength && asText.length > field.maxLength) {
    value = clip(asText, field.maxLength);
  }

  if (Array.isArray(field.mustInclude)) {
    for (const required of field.mustInclude) {
      if (!asText.includes(required)) {
        throw new ContractError(
          ERR.BAD_FORMAT,
          `格式不合规：${where} 必须包含「${required}」。当前值未包含，请在该字段中显式写入这个短语后重试。`,
          502,
          { where, missing: required },
        );
      }
    }
  }

  if (Array.isArray(field.mustIncludeAny) && field.mustIncludeAny.length > 0) {
    const hit = field.mustIncludeAny.some((token) =>
      token instanceof RegExp ? token.test(asText) : asText.includes(token),
    );
    if (!hit) {
      throw new ContractError(
        ERR.BAD_FORMAT,
        `格式不合规：${where} 必须命中以下任一表达：${field.mustIncludeAny.map(String).join(" / ")}。`,
        502,
        { where, accepted: field.mustIncludeAny.map(String) },
      );
    }
  }

  if (Array.isArray(field.forbid)) {
    for (const pattern of field.forbid) {
      const re = pattern instanceof RegExp ? pattern : new RegExp(String(pattern));
      const match = re.exec(asText);
      if (match) {
        throw new ContractError(
          ERR.BAD_FORMAT,
          `命中禁用表达：${where} 匹配到「${match[0]}」，该内容不允许出现。请改写该句后重试。`,
          502,
          { where, matched: match[0] },
        );
      }
    }
  }

  if (Array.isArray(field.rules)) {
    for (const rule of field.rules) {
      if (!rule.test.test(asText)) {
        throw new ContractError(
          ERR.BAD_FORMAT,
          `格式不合规：${where} ${rule.message}。当前值：${clip(asText, 120)}。期望形式：${rule.example ?? rule.test}。`,
          502,
          { where, actual: clip(asText, 200) },
        );
      }
    }
  }

  return value;
}

export function parseLooseJson(raw) {
  const text = String(raw ?? "").trim();
  if (!text) {
    throw new ContractError(ERR.BAD_JSON, "模型没有返回内容。请确认 CLI 的 stdout 承载了最终 JSON。", 502);
  }

  const stripped = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();

  try {
    return JSON.parse(stripped);
  } catch {
    for (const [open, close] of [["{", "}"], ["[", "]"]]) {
      const start = stripped.indexOf(open);
      const end = stripped.lastIndexOf(close);
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(stripped.slice(start, end + 1));
        } catch {
          continue;
        }
      }
    }
  }

  throw new ContractError(
    ERR.BAD_JSON,
    "模型返回内容不是合法 JSON。请只返回 JSON 对象，不要加 Markdown 围栏或解释文字。",
    502,
    clip(stripped, 600),
  );
}

export function resolveCount(contract) {
  if (typeof contract.count === "number") return { exact: contract.count };
  if (contract.count && typeof contract.count === "object") return contract.count;
  return null;
}

export function normalizeItems(contract, parsed, ctx = {}) {
  const items = Array.isArray(parsed) ? parsed : parsed?.items;
  if (!Array.isArray(items)) {
    throw new ContractError(
      ERR.BAD_JSON,
      `契约「${contract.name}」要求顶层包含 items 数组，实际收到 ${Array.isArray(parsed) ? "数组" : typeof parsed}。`,
      502,
    );
  }

  const expected = resolveCount(contract);
  if (expected?.exact !== undefined && items.length !== expected.exact) {
    throw new ContractError(
      ERR.BAD_COUNT,
      `数量不合规：契约「${contract.name}」要求正好 ${expected.exact} 条，实际返回 ${items.length} 条。请重新生成，不多不少 ${expected.exact} 条。`,
      502,
      { expected: expected.exact, actual: items.length },
    );
  }
  if (expected?.min !== undefined && items.length < expected.min) {
    throw new ContractError(ERR.BAD_COUNT, `数量不足：要求至少 ${expected.min} 条，实际 ${items.length} 条。`, 502);
  }
  if (expected?.max !== undefined && items.length > expected.max) {
    throw new ContractError(ERR.BAD_COUNT, `数量超限：要求最多 ${expected.max} 条，实际 ${items.length} 条。`, 502);
  }

  const idPrefix = contract.idPrefix ?? contract.name;

  return items.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ContractError(ERR.BAD_FIELD, `${contract.name}[${index}] 不是对象。`, 502);
    }

    const out = { id: `${idPrefix}-${index + 1}` };
    for (const [key, field] of Object.entries(contract.fields)) {
      const value = checkField(contract.name, index, key, field, pickAlias(item, field), { ...ctx, index });
      if (value !== undefined) out[key] = value;
    }
    if (typeof contract.transform === "function") {
      return contract.transform(out, index, ctx);
    }
    return out;
  });
}

export function normalizeDecision(decision, parsed, options) {
  const optionIds = new Set(options.map((option) => String(option.id).trim()));

  const raw = Array.isArray(parsed?.selectedIds)
    ? parsed.selectedIds
    : typeof parsed?.[decision.alternativeKey ?? "selectedId"] === "string"
      ? [parsed[decision.alternativeKey ?? "selectedId"]]
      : [];

  const selectedIds = raw.map((id) => (typeof id === "string" ? id.trim() : "")).filter(Boolean);

  if (selectedIds.length === 0) {
    throw new ContractError(
      ERR.BAD_DECISION,
      `决策未返回任何 id。必须返回 {"selectedIds":["..."]}，且 id 必须来自提供的候选项。`,
      502,
    );
  }

  if (new Set(selectedIds).size !== selectedIds.length) {
    throw new ContractError(ERR.BAD_DECISION, "决策返回了重复的候选项 id。请只选一次。", 502);
  }

  const invalid = selectedIds.filter((id) => !optionIds.has(id));
  if (invalid.length > 0) {
    throw new ContractError(
      ERR.BAD_DECISION,
      `决策返回了不存在的候选 id：${invalid.join(", ")}。只能从提供的 options 里取 id，不能自造。可用的 id 示例：${[...optionIds].slice(0, 5).join(", ")}。`,
      502,
      { invalid, available: [...optionIds] },
    );
  }

  const min = decision.min ?? 1;
  const max = decision.max ?? 1;
  if (selectedIds.length < min || selectedIds.length > max) {
    const range = min === max ? `正好 ${min} 个` : `${min} 到 ${max} 个`;
    throw new ContractError(
      ERR.BAD_DECISION,
      `决策数量不合规：必须返回${range} id，实际返回 ${selectedIds.length} 个。`,
      502,
      { expected: { min, max }, actual: selectedIds.length },
    );
  }

  return {
    selectedIds,
    reason:
      typeof parsed?.reason === "string" && parsed.reason.trim()
        ? parsed.reason.trim()
        : "模型已根据当前上下文完成选择。",
  };
}

export function buildRepairPrompt(contract, error, previousRaw) {
  const where = error?.details?.where ?? contract.name;
  const actual = error?.details?.actual ?? error?.details?.matched ?? error?.message;
  return [
    "你上一次的输出没有通过契约校验，请只修正被指出的问题，其余内容保持不变。",
    "",
    `失败位置：${where}`,
    `实际观测值：${clip(actual, 300)}`,
    `可接受的形态：${error?.message ?? ""}`,
    "",
    "要求：",
    "- 只返回合法 JSON，不要 Markdown 围栏，不要解释文字。",
    "- 保持字段键名完全一致，不要新增或重命名字段。",
    `- 保持${contract.count ? ` ${JSON.stringify(contract.count)} 条` : ""}的数量结构。`,
    "",
    "上一次的输出原文：",
    clip(previousRaw, 2000),
  ].join("\n");
}
