import { MASKED_VALUE, type StepOutputSummary, type StepRunSummary, type Workflow, type WorkflowRun, type WorkflowStep } from "../../shared/types.js";
import { WorkflowStore } from "./store.js";
import {
  clampDelayMs,
  collectSensitiveValues,
  describeStep,
  diffVariables,
  isSensitiveKey,
  maskSensitiveContent,
  maskVariables,
  snapshotVariables,
  truncateValue
} from "./summary.js";

function interpolate(value: string, variables: Record<string, string>): string {
  return value.replace(/{{\s*([\w.-]+)\s*}}/g, (_, key: string) => variables[key] ?? `{{${key}}}`);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Step-summary collection is observability only: it must never change the
 * outcome of a run. Every summary write goes through this wrapper so a
 * failure while recording is swallowed instead of failing the workflow.
 */
function record(store: WorkflowStore, runId: string, collect: () => void): void {
  try {
    collect();
  } catch (error) {
    console.warn(`[run ${runId}] step summary collection failed; continuing run`, error);
  }
}

export async function executeWorkflow(store: WorkflowStore, workflow: Workflow, run: WorkflowRun): Promise<void> {
  store.updateRun(run.id, { status: "running" });
  store.appendLog(run.id, "info", `Started workflow “${workflow.name}”.`);

  record(store, run.id, () => {
    const initial: StepRunSummary[] = workflow.steps.map((step, index) => ({
      position: index + 1,
      stepId: step.id,
      type: step.type,
      label: describeStep(step),
      status: "pending",
      inputs: buildStepInputs(step),
      changes: []
    }));
    store.initStepSummaries(run.id, initial);
  });

  try {
    for (const [index, step] of workflow.steps.entries()) {
      await executeStepWithSummary(store, run.id, step, index + 1);
    }
    store.updateRun(run.id, { status: "completed", finishedAt: new Date().toISOString() });
    store.appendLog(run.id, "info", "Workflow completed successfully.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown execution error";
    store.appendLog(run.id, "error", message);
    store.updateRun(run.id, { status: "failed", error: message, finishedAt: new Date().toISOString() });
    record(store, run.id, () => store.markPendingStepsSkipped(run.id));
  }
}

async function executeStepWithSummary(store: WorkflowStore, runId: string, step: WorkflowStep, position: number): Promise<void> {
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  // Delay steps spend their life waiting; everything else is "running" while it executes.
  const activeStatus = step.type === "delay" ? "waiting" : "running";
  record(store, runId, () => store.updateStepSummary(runId, position, { status: activeStatus, startedAt }));

  const before = snapshotVariables(store.getRun(runId)?.variables ?? {});
  try {
    const outputs = await executeStep(store, runId, step, position);
    const durationMs = Date.now() - startedAtMs;
    record(store, runId, () => {
      const after = store.getRun(runId)?.variables ?? {};
      const sensitiveValues = collectSensitiveValues({ ...before, ...after });
      const { changes, truncated } = diffVariables(before, after, sensitiveValues);
      store.updateStepSummary(runId, position, {
        status: "completed",
        finishedAt: new Date().toISOString(),
        durationMs,
        outputs,
        changes,
        changesTruncated: truncated
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown step error";
    record(store, runId, () => {
      store.updateStepSummary(runId, position, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
        error: message
      });
    });
    throw error;
  }
}

/** The step's configuration as executed, truncated and with sensitive values masked. */
function buildStepInputs(step: WorkflowStep): Record<string, string> {
  if (step.type === "log") return { message: truncateValue(step.message) };
  if (step.type === "set") {
    return {
      key: step.key,
      value: isSensitiveKey(step.key) ? MASKED_VALUE : truncateValue(step.value)
    };
  }
  return { requestedDurationMs: String(step.durationMs), effectiveDurationMs: String(clampDelayMs(step.durationMs)) };
}

async function executeStep(store: WorkflowStore, runId: string, step: WorkflowStep, position: number): Promise<StepOutputSummary> {
  store.appendLog(runId, "info", `Step ${position}: ${step.type}`);
  const run = store.getRun(runId);
  if (!run) throw new Error("Run disappeared while executing");

  // Logs and outputs are rendered from a masked view so sensitive values never leak.
  const safeVariables = maskVariables(run.variables);
  const sensitiveValues = collectSensitiveValues(run.variables);

  if (step.type === "log") {
    const message = interpolate(step.message, safeVariables);
    store.appendLog(runId, "info", message);
    return { logged: truncateValue(message) };
  }

  if (step.type === "set") {
    const value = interpolate(step.value, run.variables);
    store.setVariable(runId, step.key, value);
    const displayValue = isSensitiveKey(step.key) ? MASKED_VALUE : maskSensitiveContent(value, sensitiveValues);
    store.appendLog(runId, "info", `Set ${step.key} = ${displayValue}`);
    return { assigned: truncateValue(displayValue) };
  }

  const durationMs = clampDelayMs(step.durationMs);
  store.appendLog(runId, "info", `Waiting ${durationMs} ms.`);
  await wait(durationMs);
  return { waitedMs: durationMs };
}
