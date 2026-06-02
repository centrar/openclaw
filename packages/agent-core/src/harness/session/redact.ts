const NVIDIA_API_KEY_RE = /\bnvapi-[A-Za-z0-9_-]+\b/gu;
const NVIDIA_BEARER_RE = /\bBearer\s+nvapi-[A-Za-z0-9_-]+\b/giu;
const GENERIC_BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{18,}\b/gu;
const SECRET_ASSIGNMENT_RE =
  /\b([A-Z0-9_]*(?:API[_-]?KEYS?|TOKEN|SECRET|PASSWORD|PASSWD))\b\s*([=:])\s*(["']?)([^\s"',;\\]+(?:,[^\s"',;\\]+)*)\3/giu;

function redactSensitiveText(value: string): string {
  return value
    .replace(NVIDIA_BEARER_RE, "Bearer [REDACTED_NVIDIA_API_KEY]")
    .replace(NVIDIA_API_KEY_RE, "[REDACTED_NVIDIA_API_KEY]")
    .replace(
      SECRET_ASSIGNMENT_RE,
      (_match: string, key: string, separator: string, quote: string) => {
        return `${key}${separator}${quote || ""}[REDACTED_SECRET]${quote || ""}`;
      },
    )
    .replace(GENERIC_BEARER_RE, "Bearer [REDACTED_SECRET]");
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function redactValue<T>(value: T, seen: WeakSet<object>): T {
  if (typeof value === "string") {
    return redactSensitiveText(value) as T;
  }
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]" as T;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const redacted = value.map((entry) => redactValue(entry, seen));
    seen.delete(value);
    return redacted as T;
  }
  if (!isPlainObject(value)) {
    seen.delete(value);
    return value;
  }
  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[redactSensitiveText(key)] = redactValue(entry, seen);
  }
  seen.delete(value);
  return redacted as T;
}

export function redactSessionValue<T>(value: T): T {
  return redactValue(value, new WeakSet<object>());
}
