import type { ValuePreview, VariableChange } from "../../shared/types.js";

/** Maximum number of characters kept in a single preview value. */
export const MAX_PREVIEW_LENGTH = 160;
const REDACTED = "********";
const REDACTED_PREVIEW: ValuePreview = { text: REDACTED, redacted: true, truncated: false, length: 0 };

const SENSITIVE_PATTERN = /(token|secret|password|passwd|pwd|credential|apikey|api[_-]?key|auth|private[_-]?key)/i;

/** A variable key is considered sensitive if any dot/case-separated segment looks like a credential. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_PATTERN.test(key);
}

/** Replace every occurrence of known secret values inside free text (e.g. rendered log messages). */
export function maskSecretsInText(text: string, variables: Record<string, string>): string {
  const secrets = Object.keys(variables)
    .filter(isSensitiveKey)
    .map((key) => variables[key])
    .filter((value) => typeof value === "string" && value.length > 0)
    // Mask longer secrets first so a short prefix cannot hide inside a longer one.
    .sort((a, b) => b.length - a.length);
  let result = text;
  for (const secret of new Set(secrets)) {
    result = result.split(secret).join(REDACTED);
  }
  return result;
}

/** Build a display-safe preview of a raw value, redacting the whole value for sensitive keys. */
export function describeValue(rawValue: string, keyHint?: string): ValuePreview {
  if (keyHint !== undefined && isSensitiveKey(keyHint)) return { ...REDACTED_PREVIEW, length: rawValue.length };
  if (rawValue.length <= MAX_PREVIEW_LENGTH) {
    return { text: rawValue, redacted: false, truncated: false, length: rawValue.length };
  }
  return { text: `${rawValue.slice(0, MAX_PREVIEW_LENGTH)}…`, redacted: false, truncated: true, length: rawValue.length };
}

/**
 * Diff two variable snapshots, returning only added/updated keys with safe previews.
 * `keyHint` lets callers redact values for keys that are not yet present in `before`
 * (e.g. the key a `set` step is about to write).
 */
export function diffVariables(
  before: Record<string, string>,
  after: Record<string, string>,
  keyHint?: string
): VariableChange[] {
  const changes: VariableChange[] = [];
  for (const key of Object.keys(after)) {
    if (Object.prototype.hasOwnProperty.call(before, key) && before[key] === after[key]) continue;
    const existed = Object.prototype.hasOwnProperty.call(before, key);
    const sensitive = isSensitiveKey(key) || (keyHint !== undefined && key === keyHint && isSensitiveKey(keyHint));
    changes.push({
      key,
      kind: existed ? "updated" : "added",
      ...(existed ? { before: sensitive ? { ...REDACTED_PREVIEW, length: before[key].length } : describeValue(before[key]) } : {}),
      after: sensitive ? { ...REDACTED_PREVIEW, length: after[key].length } : describeValue(after[key])
    });
  }
  return changes;
}

/** Cap the number of per-step summaries a single run keeps, to bound memory and payload size. */
export const MAX_STEP_SUMMARIES = 2_000;
