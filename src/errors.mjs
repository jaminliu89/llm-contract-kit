export class ContractError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = "ContractError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const ERR = {
  BAD_REQUEST: "BAD_REQUEST",
  BAD_JSON: "LLM_BAD_JSON",
  BAD_COUNT: "LLM_BAD_COUNT",
  BAD_FIELD: "LLM_BAD_FIELD",
  BAD_FORMAT: "LLM_BAD_FORMAT",
  BAD_DECISION: "LLM_BAD_DECISION",
  UPSTREAM_HTTP: "UPSTREAM_HTTP",
  UPSTREAM_TIMEOUT: "UPSTREAM_TIMEOUT",
  CLI_UNAVAILABLE: "CLI_UNAVAILABLE",
  CLI_FAILED: "CLI_FAILED",
  CLI_TIMEOUT: "CLI_TIMEOUT",
  CLI_OUTPUT_TOO_LARGE: "CLI_OUTPUT_TOO_LARGE",
  CLI_BAD_OUTPUT: "CLI_BAD_OUTPUT",
  CONFIG_INVALID: "CONFIG_INVALID",
};

export function toHttpBody(error) {
  if (error instanceof ContractError) {
    return {
      status: error.status,
      body: { ok: false, code: error.code, error: error.message, details: error.details },
    };
  }
  return {
    status: 500,
    body: { ok: false, code: "INTERNAL_ERROR", error: String(error?.message ?? error) },
  };
}
