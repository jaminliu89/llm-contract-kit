const TOKEN_PATTERNS = [
  [/xsec_token=([^&\s"']+)/gi, "xsec_token=[redacted]"],
  [/(["']xsec_token["']\s*:\s*["'])([^"']+)(["'])/gi, "$1[redacted]$3"],
  [/(\ba1=)([^;\s]+)/gi, "$1[redacted]"],
  [/(["']a1["']\s*:\s*["'])([^"']+)(["'])/gi, "$1[redacted]$3"],
  [/(\bweb_session=)([^;\s]+)/gi, "$1[redacted]"],
  [/(["']web_session["']\s*:\s*["'])([^"']+)(["'])/gi, "$1[redacted]$3"],
  [/(Bearer\s+)([A-Za-z0-9._\-]{8,})/g, "$1[redacted]"],
  [/(\bsk-[A-Za-z0-9_\-]{8,})/g, "[redacted-api-key]"],
];

export function sanitizeDetails(value, secret = undefined, maxLength = 1200) {
  let text = String(value ?? "").replace(/\u001b\[[0-9;]*m/g, "");

  if (secret && String(secret).length >= 6) {
    text = text.split(String(secret)).join("[redacted]");
  }

  for (const [pattern, replacement] of TOKEN_PATTERNS) {
    text = text.replace(pattern, replacement);
  }

  text = text.replace(/\s+/g, " ").trim();

  if (text.length > maxLength) {
    text = `${text.slice(0, maxLength - 1)}…`;
  }
  return text;
}

export function assertNoSecretLeak(payload, secret) {
  if (!secret || String(secret).length < 6) return true;
  const serialized = JSON.stringify(payload ?? {});
  return !serialized.includes(String(secret));
}
