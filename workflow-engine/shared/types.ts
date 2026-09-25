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

export interface RunLog {
  at: string;
  level: "info" | "error";
  message: string;
}

/** Placeholder shown anywhere a sensitive variable value would appear. */
export const MASKED_VALUE = "••••••••";

export type StepRunStatus = "pending" | "running" | "waiting" | "completed" | "failed" | "skipped";

export type VariableChangeAction = "added" | "updated" | "unchanged";

export interface VariableChange {
  key: string;
  action: VariableChangeAction;
  /** Truncated, masked value before the step ran. Absent for newly added variables. */
  before?: string;
  /** Truncated, masked value after the step ran. */
  after: string;
  /** True when the variable name looks sensitive; before/after are masked placeholders. */
  sensitive: boolean;
}

export interface StepOutputSummary {
  /** Masked + truncated message emitted by a log step. */
  logged?: string;
  /** Masked + truncated value written by a set step. */
  assigned?: string;
  /** Actual milliseconds a delay step waited. */
  waitedMs?: number;
}

export interface StepRunSummary {
  /** 1-based position in the workflow's step list. */
  position: number;
  stepId: string;
  type: StepType;
  /** Short human-readable description of the step. */
  label: string;
  status: StepRunStatus;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  /** Truncated, masked view of the step's configuration as executed. */
  inputs: Record<string, string>;
  outputs?: StepOutputSummary;
  /** Variable diff caused by this step. */
  changes: VariableChange[];
  /** True when the changes list was capped and some entries were omitted. */
  changesTruncated?: boolean;
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
   * Per-step input/output summaries in execution order.
   * Optional: runs recorded before this feature shipped have no summaries,
   * and clients must degrade gracefully in that case.
   */
  stepSummaries?: StepRunSummary[];
}

export interface CreateWorkflowInput {
  name: string;
  description?: string;
  steps: WorkflowStep[];
}
