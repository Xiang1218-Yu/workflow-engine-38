import { randomUUID } from "node:crypto";
import type {
  CreateWorkflowInput,
  StepSummary,
  StepSummaryStatus,
  Workflow,
  WorkflowRun,
  WorkflowStep
} from "../../shared/types.js";
import { MAX_STEP_SUMMARIES } from "./telemetry.js";

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

  // --- Step summary telemetry -------------------------------------------------
  // Every method below is best-effort: a telemetry failure must never propagate
  // into workflow execution or change the run status. They return false when the
  // summary could not be recorded so callers can ignore it.

  startStepSummary(id: string, summary: StepSummary): boolean {
    const run = this.runs.get(id);
    if (!run || !Array.isArray(run.stepSummaries)) return false;
    if (run.stepSummaries.some((entry) => entry.stepId === summary.stepId)) return false;
    if (run.stepSummaries.length >= MAX_STEP_SUMMARIES) return false;
    run.stepSummaries.push(summary);
    return true;
  }

  updateStepSummary(id: string, stepId: string, patch: Partial<StepSummary>): boolean {
    const run = this.runs.get(id);
    if (!run || !Array.isArray(run.stepSummaries)) return false;
    const entry = run.stepSummaries.find((candidate) => candidate.stepId === stepId);
    if (!entry) return false;
    Object.assign(entry, patch);
    return true;
  }

  markStepsSkipped(id: string, afterOrder: number, remainingSteps?: WorkflowStep[]): void {
    const run = this.runs.get(id);
    if (!run || !Array.isArray(run.stepSummaries)) return;
    const at = new Date().toISOString();
    // Mark in-flight steps (running/waiting when the failure happened) as skipped.
    for (const summary of run.stepSummaries) {
      if (summary.order <= afterOrder) continue;
      if (summary.status === "completed" || summary.status === "failed") continue;
      Object.assign(summary, {
        status: "skipped" satisfies StepSummaryStatus,
        finishedAt: summary.finishedAt ?? at
      });
    }
    // Steps that never started have no summary yet; record skipped entries for them.
    const knownIds = new Set(run.stepSummaries.map((summary) => summary.stepId));
    if (remainingSteps) {
      for (const [offset, step] of remainingSteps.entries()) {
        if (knownIds.has(step.id)) continue;
        if (run.stepSummaries.length >= MAX_STEP_SUMMARIES) break;
        run.stepSummaries.push({
          stepId: step.id,
          order: afterOrder + offset + 1,
          type: step.type,
          status: "skipped",
          finishedAt: at,
          changes: []
        });
      }
    }
  }
}

export function validateSteps(steps: unknown): steps is WorkflowStep[] {
  if (!Array.isArray(steps) || steps.length === 0) return false;
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
