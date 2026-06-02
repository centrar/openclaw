"use strict";

const NVIDIA_API_KEY_RE = /\bnvapi-[A-Za-z0-9_-]+\b/gu;
const NVIDIA_BEARER_RE = /\bBearer\s+nvapi-[A-Za-z0-9_-]+\b/giu;
const GENERIC_BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{18,}\b/gu;
const SECRET_ASSIGNMENT_RE =
  /\b([A-Z0-9_]*(?:API[_-]?KEYS?|TOKEN|SECRET|PASSWORD|PASSWD))\b\s*([=:])\s*(["']?)([^\s"',;\\]+(?:,[^\s"',;\\]+)*)\3/giu;

function redactSensitiveText(value) {
  return String(value)
    .replace(NVIDIA_BEARER_RE, "Bearer [REDACTED_NVIDIA_API_KEY]")
    .replace(NVIDIA_API_KEY_RE, "[REDACTED_NVIDIA_API_KEY]")
    .replace(SECRET_ASSIGNMENT_RE, (_match, key, separator, quote) => {
      return `${key}${separator}${quote || ""}[REDACTED_SECRET]${quote || ""}`;
    })
    .replace(GENERIC_BEARER_RE, "Bearer [REDACTED_SECRET]");
}

function isPlainObject(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function redactSensitiveValue(value, seen = new WeakSet()) {
  if (typeof value === "string") {
    return redactSensitiveText(value);
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const redacted = value.map((entry) => redactSensitiveValue(entry, seen));
    seen.delete(value);
    return redacted;
  }
  if (!isPlainObject(value)) {
    seen.delete(value);
    return value;
  }
  const redacted = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[redactSensitiveText(key)] = redactSensitiveValue(entry, seen);
  }
  seen.delete(value);
  return redacted;
}

function containsRawNvidiaApiKey(value) {
  NVIDIA_API_KEY_RE.lastIndex = 0;
  return NVIDIA_API_KEY_RE.test(String(value));
}

module.exports = {
  NVIDIA_API_KEY_RE,
  containsRawNvidiaApiKey,
  redactSensitiveText,
  redactSensitiveValue,
};
