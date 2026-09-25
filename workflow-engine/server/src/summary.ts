import { MASKED_VALUE, type VariableChange, type WorkflowStep } from "../../shared/types.js";

/** Values stored in step summaries are capped so a single huge variable cannot bloat the run payload. */
export const MAX_SUMMARY_VALUE_LENGTH = 200;
/** Variable diffs are capped so a runaway step cannot produce an unbounded summary. */
export const MAX_CHANGES_PER_STEP = 50;
export const MAX_DELAY_MS = 60_000;

const SENSITIVE_KEY_PATTERN = /(?:^|[._-])(?:password|passwd|pwd|secret|token|api[-_]?key|credential|authorization|cookie|session|private)(?:$|[._-])/i;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

export function truncateValue(value: string, maxLength = MAX_SUMMARY_VALUE_LENGTH): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}… (+${value.length - maxLength} chars)`;
}

/** Values worth hiding anywhere they might be interpolated (logs, inputs, outputs). */
export function collectSensitiveValues(variables: Record<string, string>): string[] {
  return Object.entries(variables)
    .filter(([key, value]) => value.length > 0 && isSensitiveKey(key))
    .map(([, value]) => value);
}

/** Replace any occurrence of a sensitive variable's value inside arbitrary text. */
export function maskSensitiveContent(text: string, sensitiveValues: string[]): string {
  let masked = text;
  for (const value of sensitiveValues) {
    masked = masked.split(value).join(MASKED_VALUE);
  }
  return masked;
}

/** A copy of the variables where sensitive values are replaced by the mask token. */
export function maskVariables(variables: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const [key, value] of Object.entries(variables)) {
    masked[key] = isSensitiveKey(key) ? MASKED_VALUE : value;
  }
  return masked;
}

export function snapshotVariables(variables: Record<string, string>): Record<string, string> {
  return { ...variables };
}

export interface VariableDiff {
  changes: VariableChange[];
  truncated: boolean;
}

/** Diff two variable snapshots; reported values are truncated and sensitive values are masked. */
export function diffVariables(before: Record<string, string>, after: Record<string, string>, sensitiveValues: string[] = []): VariableDiff {
  const changes: VariableChange[] = [];
  let truncated = false;
  const display = (key: string, value: string): string =>
    isSensitiveKey(key) ? MASKED_VALUE : truncateValue(maskSensitiveContent(value, sensitiveValues));
  for (const key of Object.keys(after)) {
    const hadKey = Object.prototype.hasOwnProperty.call(before, key);
    const previous = before[key];
    const next = after[key];
    if (hadKey && previous === next) continue;
    if (changes.length >= MAX_CHANGES_PER_STEP) {
      truncated = true;
      break;
    }
    changes.push({
      key,
      action: hadKey ? "updated" : "added",
      ...(hadKey ? { before: display(key, previous) } : {}),
      after: display(key, next),
      sensitive: isSensitiveKey(key)
    });
  }
  return { changes, truncated };
}

export function clampDelayMs(durationMs: number): number {
  return Math.min(Math.max(0, durationMs), MAX_DELAY_MS);
}

/** Short human-readable description of a step, safe to show in the timeline (templates truncated, values masked). */
export function describeStep(step: WorkflowStep): string {
  if (step.type === "log") return `Log “${truncateValue(step.message, 60)}”`;
  if (step.type === "set") return `Set ${step.key}`;
  return `Wait ${clampDelayMs(step.durationMs)} ms`;
}
