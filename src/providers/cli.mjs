import { spawn } from "node:child_process";
import { ContractError, ERR } from "../errors.mjs";
import { sanitizeDetails } from "../redact.mjs";

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DETECT_TIMEOUT_MS = 5_000;

export function validateCommand(command) {
  const value = String(command ?? "").trim();
  if (!value || value.length > 500 || value.includes("\0")) {
    throw new ContractError(ERR.CONFIG_INVALID, "请填写合法的本机 CLI 命令名或绝对路径。", 400);
  }
  const isAbsolute = value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
  if (!isAbsolute && !/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new ContractError(
      ERR.CONFIG_INVALID,
      "CLI 只接受 PATH 中的命令名，或可执行文件绝对路径。不接受带空格、分号、管道等 shell 片段的命令。",
      400,
    );
  }
  return value;
}

export function spawnCollect(command, args, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    env = {},
    cwd = process.cwd(),
    label = command,
  } = options;

  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, NO_COLOR: "1", ...env },
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
    } catch (error) {
      reject(new ContractError(ERR.CLI_UNAVAILABLE, `无法启动 ${label}：${error.message}`, 503));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const append = (target, chunk) => {
      const next = target + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > maxBytes) {
        child.kill("SIGTERM");
        finish(
          reject,
          new ContractError(ERR.CLI_OUTPUT_TOO_LARGE, `${label} 输出超过 ${Math.round(maxBytes / 1024)}KB 上限，已中止。`, 502),
        );
        return target;
      }
      return next;
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(
        reject,
        new ContractError(ERR.CLI_TIMEOUT, `${label} 超过 ${Math.round(timeoutMs / 1000)}s 未返回，已中止。`, 504),
      );
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });

    child.on("error", (error) => {
      const code = error?.code;
      if (code === "ENOENT") {
        finish(
          reject,
          new ContractError(ERR.CLI_UNAVAILABLE, `找不到 ${label} 可执行文件。请先安装并确保它在 PATH 中，或用绝对路径指定。`, 503),
        );
        return;
      }
      if (code === "EACCES" || code === "EPERM") {
        finish(reject, new ContractError(ERR.CLI_UNAVAILABLE, `${label} 存在但没有执行权限，请 chmod +x 后重试。`, 503));
        return;
      }
      finish(reject, new ContractError(ERR.CLI_UNAVAILABLE, `无法启动 ${label}：${error.message}`, 503));
    });

    child.on("close", (code) => {
      const durationMs = Date.now() - startedAt;
      if (code !== 0) {
        finish(
          reject,
          new ContractError(
            ERR.CLI_FAILED,
            `${label} 执行失败，退出码 ${code}。`,
            502,
            sanitizeDetails(stderr || stdout),
          ),
        );
        return;
      }
      finish(resolve, { stdout: stdout.trim(), stderr: stderr.trim(), durationMs });
    });
  });
}

export async function probeCommand(command, label = command) {
  try {
    const result = await spawnCollect(command, ["--version"], {
      timeoutMs: DETECT_TIMEOUT_MS,
      label,
    });
    return { available: true, version: sanitizeDetails(result.stdout || result.stderr, undefined, 120) };
  } catch (error) {
    return { available: false, error: error.message };
  }
}
