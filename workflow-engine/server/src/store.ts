import { randomUUID } from "node:crypto";
import type { CreateWorkflowInput, StepRunSummary, Workflow, WorkflowRun, WorkflowStep } from "../../shared/types.js";

/** Hard cap on steps per workflow so run payloads (and the run inspector) stay manageable. */
export const MAX_STEPS_PER_WORKFLOW = 500;

export class WorkflowStore {
  private readonly workflows = new Map<string, Workflow>();
  private readonly runs = new Map<string, WorkflowRun>();

  constructor(seed = true) {
    if (seed) {
      const now = new Date().toISOString();
      const sample: Workflow = {
        id: "welcome-workflow",
        name: "Welcome workflow",
        description: "A small example that demonstrates logs, variables, and a delay.",
        steps: [
          { id: "welcome-log", type: "log", message: "Hello {{name}}!" },
          { id: "welcome-set", type: "set", key: "name", value: "workflow builder" },
          { id: "welcome-delay", type: "delay", durationMs: 250 },
          { id: "welcome-done", type: "log", message: "The workflow is complete." }
        ],
        createdAt: now,
        updatedAt: now
      };
      this.workflows.set(sample.id, sample);
    }
  }

  listWorkflows(): Workflow[] {
    return [...this.workflows.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getWorkflow(id: string): Workflow | undefined {
    return this.workflows.get(id);
  }

  createWorkflow(input: CreateWorkflowInput): Workflow {
    const now = new Date().toISOString();
    const workflow: Workflow = {
      id: randomUUID(),
      name: input.name.trim(),
      description: (input.description ?? "").trim(),
      steps: input.steps,
      createdAt: now,
      updatedAt: now
    };
    this.workflows.set(workflow.id, workflow);
    return workflow;
  }

  createRun(workflowId: string): WorkflowRun {
    const run: WorkflowRun = {
      id: randomUUID(),
      workflowId,
      status: "queued",
      startedAt: new Date().toISOString(),
      logs: [],
      variables: {},
      stepSummaries: []
    };
    this.runs.set(run.id, run);
    return run;
  }

  getRun(id: string): WorkflowRun | undefined {
    return this.runs.get(id);
  }

  listRuns(workflowId: string): WorkflowRun[] {
    return [...this.runs.values()]
      .filter((run) => run.workflowId === workflowId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  updateRun(id: string, update: Partial<WorkflowRun>): WorkflowRun {
    const run = this.runs.get(id);
    if (!run) throw new Error(`Run ${id} not found`);
    Object.assign(run, update);
    return run;
  }

  appendLog(id: string, level: "info" | "error", message: string): void {
    const run = this.runs.get(id);
    if (!run) throw new Error(`Run ${id} not found`);
    run.logs.push({ at: new Date().toISOString(), level, message });
  }

  setVariable(id: string, key: string, value: string): void {
    const run = this.runs.get(id);
    if (!run) throw new Error(`Run ${id} not found`);
    run.variables[key] = value;
  }

  /** Pre-populate one summary row per step, in execution order, before the run starts. */
  initStepSummaries(id: string, summaries: StepRunSummary[]): void {
    const run = this.runs.get(id);
    if (!run) throw new Error(`Run ${id} not found`);
    run.stepSummaries = summaries;
  }

  updateStepSummary(id: string, position: number, update: Partial<StepRunSummary>): void {
    const run = this.runs.get(id);
    if (!run) throw new Error(`Run ${id} not found`);
    const summary = run.stepSummaries?.find((entry) => entry.position === position);
    if (summary) Object.assign(summary, update);
  }

  /** Steps that never ran (e.g. after a failure) become explicitly "skipped" instead of staying pending. */
  markPendingStepsSkipped(id: string): void {
    const run = this.runs.get(id);
    if (!run) throw new Error(`Run ${id} not found`);
    for (const summary of run.stepSummaries ?? []) {
      if (summary.status === "pending") summary.status = "skipped";
    }
  }
}

export function validateSteps(steps: unknown): steps is WorkflowStep[] {
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > MAX_STEPS_PER_WORKFLOW) return false;
  return steps.every((step) => {
    if (!step || typeof step !== "object") return false;
    const candidate = step as Record<string, unknown>;
    if (typeof candidate.id !== "string" || candidate.id.length === 0) return false;
    if (candidate.type === "log") return typeof candidate.message === "string";
    if (candidate.type === "set") return typeof candidate.key === "string" && candidate.key.length > 0 && typeof candidate.value === "string";
    if (candidate.type === "delay") return Number.isFinite(candidate.durationMs) && Number(candidate.durationMs) >= 0 && Number(candidate.durationMs) <= 60_000;
    return false;
  });
}
