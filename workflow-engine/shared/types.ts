export type StepType = "log" | "set" | "delay";

export interface LogStep {
  id: string;
  type: "log";
  message: string;
}

export interface SetStep {
  id: string;
  type: "set";
  key: string;
  value: string;
}

export interface DelayStep {
  id: string;
  type: "delay";
  durationMs: number;
}

export type WorkflowStep = LogStep | SetStep | DelayStep;

export interface Workflow {
  id: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
  createdAt: string;
  updatedAt: string;
}

export type RunStatus = "queued" | "running" | "completed" | "failed";

/**
 * Lifecycle of a single step within a run:
 * - running: a non-delay step is executing (usually very brief).
 * - waiting: a delay step is sleeping for its configured duration.
 * - pending: the step has not started yet (display-only inference during live runs).
 * - completed / failed: terminal states for an executed step.
 * - skipped: the step was never reached because an earlier step failed.
 */
export type StepSummaryStatus = "running" | "waiting" | "pending" | "completed" | "failed" | "skipped";

export interface RunLog {
  at: string;
  level: "info" | "error";
  message: string;
}

/** A display-safe snippet of a variable value or step input/output. */
export interface ValuePreview {
  /** Safe-to-display text; "********" when redacted, truncated with an ellipsis when too long. */
  text: string;
  redacted: boolean;
  truncated: boolean;
  /** Full (unmasked) value length, so the UI can hint at what is hidden. */
  length: number;
}

export interface VariableChange {
  key: string;
  kind: "added" | "updated";
  /** Absent for added variables. */
  before?: ValuePreview;
  after: ValuePreview;
}

export interface StepSummary {
  stepId: string;
  /** 1-based position in actual execution order. */
  order: number;
  type: StepType;
  status: StepSummaryStatus;
  startedAt?: string;
  finishedAt?: string;
  /** Wall-clock duration measured around step execution. */
  durationMs?: number;
  inputPreview?: ValuePreview;
  outputPreview?: ValuePreview;
  /** Variable keys added or updated by this step (already redacted/truncated). */
  changes: VariableChange[];
  error?: string;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  logs: RunLog[];
  variables: Record<string, string>;
  error?: string;
  /**
   * Per-step execution summaries. Absent/empty for runs created before this
   * feature existed; the UI must degrade gracefully in that case.
   */
  stepSummaries?: StepSummary[];
}

export interface CreateWorkflowInput {
  name: string;
  description?: string;
  steps: WorkflowStep[];
}
