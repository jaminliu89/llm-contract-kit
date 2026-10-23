import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ContractError, ERR } from "../errors.mjs";
import { sanitizeDetails } from "../redact.mjs";
import { spawnCollect, validateCommand } from "../providers/cli.mjs";

const TEXT_TIMEOUT_MS = 180_000;

function modelArgs(model, flag = "--model") {
  const value = String(model ?? "").trim();
  if (!value) return [];
  if (value.includes("/") || /\s/.test(value)) return [];
  return [flag, value];
}

function parseStreamJsonAssistant(stdout, label) {
  let last = "";
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event?.role !== "assistant") continue;
      if (typeof event.content === "string" && event.content.trim()) {
        last = event.content;
        continue;
      }
      if (Array.isArray(event.content)) {
        const text = event.content
          .map((part) => (typeof part === "string" ? part : part?.text))
          .filter(Boolean)
          .join("\n");
        if (text.trim()) last = text;
      }
    } catch {
      continue;
    }
  }
  if (!last.trim()) {
    throw new ContractError(
      ERR.CLI_BAD_OUTPUT,
      `${label} 的 stdout 里没有找到 {"role":"assistant","content":"..."} 行。请确认该 CLI 符合 print protocol。`,
      502,
    );
  }
  return last.trim();
}

async function runCodex({ command, prompt, model }) {
  const workDir = await mkdtemp(path.join(tmpdir(), "contract-codex-"));
  const outputPath = path.join(workDir, "last-message.txt");
  try {
    const args = [
      "exec",
      "-C",
      process.cwd(),
      "--skip-git-repo-check",
      "-c",
      'model_reasoning_effort="low"',
      "--sandbox",
      "read-only",
      "--output-last-message",
      outputPath,
      ...modelArgs(model, "-m"),
      prompt,
    ];
    const result = await spawnCollect(command, args, { timeoutMs: TEXT_TIMEOUT_MS, label: "Codex CLI" });
    const raw = (await readFile(outputPath, "utf8").catch(() => "")).trim();
    if (!raw) {
      throw new ContractError(
        ERR.CLI_BAD_OUTPUT,
        "Codex CLI 没有写出 last-message 文件。可能是 --output-last-message 参数不被当前版本支持。",
        502,
        sanitizeDetails(result.stdout || result.stderr),
      );
    }
    return { raw, ...result, commandPreview: `${path.basename(command)} exec ... --output-last-message [file] ... [prompt]` };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function runKimi({ command, prompt, model }) {
  const args = [...modelArgs(model), "--prompt", prompt, "--output-format", "stream-json"];
  const result = await spawnCollect(command, args, { timeoutMs: TEXT_TIMEOUT_MS, label: "Kimi CLI" });
  return {
    raw: parseStreamJsonAssistant(result.stdout, "Kimi CLI"),
    ...result,
    commandPreview: `${path.basename(command)} --prompt [prompt] --output-format stream-json`,
  };
}

async function runClaude({ command, prompt, model }) {
  const args = [
    ...modelArgs(model),
    "--print",
    prompt,
    "--output-format",
    "json",
    "--safe-mode",
    "--tools",
    "",
    "--no-session-persistence",
  ];
  const result = await spawnCollect(command, args, { timeoutMs: TEXT_TIMEOUT_MS, label: "Claude Code" });

  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new ContractError(
      ERR.CLI_BAD_OUTPUT,
      "Claude Code 没有返回合法 JSON。请确认 --output-format json 生效。",
      502,
      sanitizeDetails(result.stdout),
    );
  }
  if (payload?.is_error) {
    throw new ContractError(ERR.CLI_FAILED, "Claude Code 返回了执行错误。", 502, sanitizeDetails(payload?.result));
  }
  const raw =
    typeof payload?.result === "string" && payload.result.trim()
      ? payload.result.trim()
      : payload?.structured_output && typeof payload.structured_output === "object"
        ? JSON.stringify(payload.structured_output)
        : "";
  if (!raw) {
    throw new ContractError(ERR.CLI_BAD_OUTPUT, "Claude Code 返回结果里没有 result 字段。", 502, sanitizeDetails(result.stdout));
  }
  return {
    raw,
    ...result,
    commandPreview: `${path.basename(command)} --print [prompt] --output-format json --safe-mode --tools [off] --no-session-persistence`,
  };
}

async function runPrintProtocol({ command, prompt, model }) {
  const args = [...modelArgs(model), "--prompt", prompt, "--output-format", "stream-json"];
  const result = await spawnCollect(command, args, { timeoutMs: TEXT_TIMEOUT_MS, label: "规范 CLI" });
  return {
    raw: parseStreamJsonAssistant(result.stdout, "规范 CLI"),
    ...result,
    commandPreview: `${path.basename(command)} --prompt [prompt] --output-format stream-json`,
  };
}

const RUNNERS = { codex: runCodex, kimi: runKimi, claude: runClaude, custom: runPrintProtocol };

export const BUILTIN_ADAPTERS = [
  {
    id: "codex",
    label: "Codex CLI",
    capabilities: { text: true, image: true },
    envKey: "CODEX_CLI_PATH",
    defaultCommand: "codex",
  },
  {
    id: "kimi",
    label: "Kimi CLI",
    capabilities: { text: true, image: false },
    envKey: "KIMI_CLI_PATH",
    defaultCommand: "kimi",
  },
  {
    id: "claude",
    label: "Claude Code",
    capabilities: { text: true, image: false },
    envKey: "CLAUDE_CLI_PATH",
    defaultCommand: "claude",
  },
];

export function resolveAdapter(selection = {}) {
  const id = String(selection.cliId ?? "codex").trim() || "codex";

  if (id === "custom") {
    const command = validateCommand(selection.cliCommand);
    return { id: "custom", label: `规范 CLI（${path.basename(command)}）`, capabilities: { text: true, image: false }, command };
  }

  const adapter = BUILTIN_ADAPTERS.find((item) => item.id === id);
  if (!adapter) {
    throw new ContractError(ERR.CONFIG_INVALID, `不支持的本地 CLI：${id}。可选：${BUILTIN_ADAPTERS.map((a) => a.id).join(", ")}、custom。`, 400);
  }
  return {
    ...adapter,
    command: process.env[adapter.envKey] || adapter.defaultCommand,
  };
}

export async function runTextCli({ prompt, model, cliId, cliCommand }) {
  const adapter = resolveAdapter({ cliId, cliCommand });
  if (!adapter.capabilities.text) {
    throw new ContractError(ERR.CONFIG_INVALID, `${adapter.label} 未声明文本生成能力。`, 400);
  }
  const runner = RUNNERS[adapter.id] ?? runPrintProtocol;
  const result = await runner({ command: adapter.command, prompt, model });
  return { ...result, cliId: adapter.id, cliLabel: adapter.label };
}

export async function detectClis({ customCommand } = {}) {
  const { probeCommand } = await import("../providers/cli.mjs");
  const results = await Promise.all(
    BUILTIN_ADAPTERS.map(async (adapter) => {
      const command = process.env[adapter.envKey] || adapter.defaultCommand;
      const probe = await probeCommand(command, adapter.label);
      return { id: adapter.id, label: adapter.label, capabilities: adapter.capabilities, command, ...probe };
    }),
  );

  if (String(customCommand ?? "").trim()) {
    const command = validateCommand(customCommand);
    const probe = await probeCommand(command, "规范 CLI");
    results.push({ id: "custom", label: `规范 CLI（${path.basename(command)}）`, capabilities: { text: true, image: false }, command, ...probe });
  }
  return results;
}
