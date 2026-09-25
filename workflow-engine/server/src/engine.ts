import type {
  StepSummaryStatus,
  StepType,
  ValuePreview,
  VariableChange,
  Workflow,
  WorkflowRun,
  WorkflowStep
} from "../../shared/types.js";
import { WorkflowStore } from "./store.js";
import { describeValue, diffVariables, isSensitiveKey, maskSecretsInText } from "./telemetry.js";

const MAX_DELAY_MS = 60_000;

function interpolate(value: string, variables: Record<string, string>): string {
  return value.replace(/{{\s*([\w.-]+)\s*}}/g, (_, key: string) => variables[key] ?? `{{${key}}}`);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function snapshot(variables: Record<string, string>): Record<string, string> {
  return { ...variables };
}

/**
 * Run a telemetry callback (store summary mutation, preview building, …).
 * Telemetry is best-effort: any error here is swallowed so observability code
 * can never change workflow execution or run status.
 */
function capture(callback: () => void): void {
  try {
    callback();
  } catch {
    // Intentionally ignored: summary collection must not affect execution.
  }
}

export async function executeWorkflow(store: WorkflowStore, workflow: Workflow, run: WorkflowRun): Promise<void> {
  store.updateRun(run.id, { status: "running" });
  store.appendLog(run.id, "info", `Started workflow “${workflow.name}”.`);

  let activeOrder = 0;
  let activeStepId: string | undefined;
  let remaining: WorkflowStep[] = [];
  try {
    for (const [index, step] of workflow.steps.entries()) {
      activeOrder = index + 1;
      activeStepId = step.id;
      remaining = workflow.steps.slice(index + 1);
      await executeStep(store, run.id, step, activeOrder);
    }
    store.updateRun(run.id, { status: "completed", finishedAt: new Date().toISOString() });
    store.appendLog(run.id, "info", "Workflow completed successfully.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown execution error";
    capture(() => {
      if (activeStepId) {
        store.updateStepSummary(run.id, activeStepId, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          error: message
        });
      }
      store.markStepsSkipped(run.id, activeOrder, remaining);
    });
    store.appendLog(run.id, "error", message);
    store.updateRun(run.id, { status: "failed", error: message, finishedAt: new Date().toISOString() });
  }
}

interface StepExecution {
  status: StepSummaryStatus;
  inputPreview?: ValuePreview;
  outputPreview?: ValuePreview;
  changes: VariableChange[];
}

async function executeStep(
  store: WorkflowStore,
  runId: string,
  step: WorkflowStep,
  position: number
): Promise<void> {
  const startedAt = new Date().toISOString();
  const startedOn = Date.now();
  const run = store.getRun(runId);
  if (!run) throw new Error("Run disappeared while executing");

  const before = snapshot(run.variables);

  store.appendLog(runId, "info", `Step ${position}: ${step.type}`);
  capture(() => {
    store.startStepSummary(runId, {
      stepId: step.id,
      order: position,
      type: step.type as StepType,
      status: "running",
      startedAt,
      changes: []
    });
  });

  const execution = await runStep(store, runId, step, before);

  const finishedAt = new Date().toISOString();
  const durationMs = Date.now() - startedOn;
  const after = store.getRun(runId)?.variables ?? before;
  capture(() => {
    store.updateStepSummary(runId, step.id, {
      status: execution.status,
      finishedAt,
      durationMs,
      inputPreview: execution.inputPreview,
      outputPreview: execution.outputPreview,
      changes: execution.changes.length > 0 ? execution.changes : diffVariables(before, after)
    });
  });
}

async function runStep(
  store: WorkflowStore,
  runId: string,
  step: WorkflowStep,
  before: Record<string, string>
): Promise<StepExecution> {
  if (step.type === "log") {
    const rendered = interpolate(step.message, before);
    store.appendLog(runId, "info", maskSecretsInText(rendered, before));
    return {
      status: "completed",
      inputPreview: describeValue(step.message),
      outputPreview: describeValue(maskSecretsInText(rendered, before)),
      changes: []
    };
  }

  if (step.type === "set") {
    const sensitive = isSensitiveKey(step.key);
    const value = interpolate(step.value, before);
    store.setVariable(runId, step.key, value);
    const after = store.getRun(runId)?.variables ?? { ...before, [step.key]: value };

    const changes = diffVariables(before, after, step.key);
    const output = sensitive
      ? { text: "********", redacted: true, truncated: false, length: value.length }
      : describeValue(value);
    // Never echo a raw secret into the log.
    store.appendLog(runId, "info", sensitive ? `Set ${step.key} = ******** (redacted)` : `Set ${step.key} = ${value}`);
    return {
      status: "completed",
      inputPreview: sensitive
        ? { text: `${step.key} = ********`, redacted: true, truncated: false, length: step.key.length + 3 + value.length }
        : describeValue(`${step.key} = ${step.value}`),
      outputPreview: output,
      changes
    };
  }

  if (step.type === "delay") {
    const durationMs = Math.min(Math.max(0, step.durationMs), MAX_DELAY_MS);
    capture(() => store.updateStepSummary(runId, step.id, { status: "waiting" }));
    store.appendLog(runId, "info", `Waiting ${durationMs} ms.`);
    await wait(durationMs);
    return {
      status: "completed",
      inputPreview: describeValue(`${durationMs} ms`),
      outputPreview: describeValue(`Waited ${durationMs} ms`),
      changes: []
    };
  }

  // Defensive: unknown step kinds fail the step (and therefore the run).
  throw new Error(`Unknown step type: ${(step as { type?: string }).type ?? "undefined"}`);
}
