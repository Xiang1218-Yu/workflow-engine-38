import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "./app.js";
import { executeWorkflow } from "./engine.js";
import { WorkflowStore } from "./store.js";
import { MASKED_VALUE, type StepRunSummary, type Workflow, type WorkflowRun } from "../../shared/types.js";

async function startTestServer(store: WorkflowStore = new WorkflowStore(false)) {
  const server = createApp(store);
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, store };
}

async function waitForRun(baseUrl: string, runId: string): Promise<WorkflowRun> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/runs/${runId}`);
    const { run } = (await response.json()) as { run: WorkflowRun };
    if (run.status === "completed" || run.status === "failed") return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Run did not finish in time");
}

async function createAndRun(baseUrl: string, steps: unknown): Promise<WorkflowRun> {
  const createResponse = await fetch(`${baseUrl}/api/workflows`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Summary test workflow", steps })
  });
  assert.equal(createResponse.status, 201);
  const { workflow } = (await createResponse.json()) as { workflow: Workflow };
  const runResponse = await fetch(`${baseUrl}/api/workflows/${workflow.id}/runs`, { method: "POST" });
  assert.equal(runResponse.status, 202);
  const { run } = (await runResponse.json()) as { run: WorkflowRun };
  return waitForRun(baseUrl, run.id);
}

function summaryAt(run: WorkflowRun, position: number): StepRunSummary {
  const summary = run.stepSummaries?.find((entry) => entry.position === position);
  assert.ok(summary, `expected a summary for step ${position}`);
  return summary;
}

test("creates a workflow and executes it", async (t) => {
  const { server, baseUrl } = await startTestServer();
  t.after(() => server.close());

  const createResponse = await fetch(`${baseUrl}/api/workflows`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Test workflow",
      steps: [
        { id: "set-1", type: "set", key: "subject", value: "tests" },
        { id: "log-1", type: "log", message: "Running {{subject}}" },
        { id: "delay-1", type: "delay", durationMs: 1 }
      ]
    })
  });
  assert.equal(createResponse.status, 201);
  const { workflow } = (await createResponse.json()) as { workflow: { id: string } };

  const runResponse = await fetch(`${baseUrl}/api/workflows/${workflow.id}/runs`, { method: "POST" });
  assert.equal(runResponse.status, 202);
  const { run } = (await runResponse.json()) as { run: { id: string } };

  let status = "queued";
  for (let attempt = 0; attempt < 20 && status !== "completed"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    const response = await fetch(`${baseUrl}/api/runs/${run.id}`);
    const body = (await response.json()) as { run: { status: string; logs: Array<{ message: string }> } };
    status = body.run.status;
    if (status === "completed") {
      assert.ok(body.run.logs.some((log) => log.message === "Running tests"));
    }
  }
  assert.equal(status, "completed");
});

test("rejects invalid workflows", async (t) => {
  const { server, baseUrl } = await startTestServer();
  t.after(() => server.close());
  const response = await fetch(`${baseUrl}/api/workflows`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "", steps: [] })
  });
  assert.equal(response.status, 400);
});

test("rejects workflows with too many steps", async (t) => {
  const { server, baseUrl } = await startTestServer();
  t.after(() => server.close());
  const steps = Array.from({ length: 501 }, (_, index) => ({ id: `s${index}`, type: "delay", durationMs: 0 }));
  const response = await fetch(`${baseUrl}/api/workflows`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Too big", steps })
  });
  assert.equal(response.status, 400);
});

test("records per-step summaries, variable diffs, and timing in execution order", async (t) => {
  const { server, baseUrl } = await startTestServer();
  t.after(() => server.close());

  const run = await createAndRun(baseUrl, [
    { id: "set-1", type: "set", key: "subject", value: "tests" },
    { id: "log-1", type: "log", message: "Running {{subject}}" },
    { id: "delay-1", type: "delay", durationMs: 25 }
  ]);

  assert.equal(run.status, "completed");
  const summaries = run.stepSummaries ?? [];
  assert.deepEqual(summaries.map((entry) => entry.position), [1, 2, 3]);
  assert.ok(summaries.every((entry) => entry.status === "completed"));

  const setStep = summaryAt(run, 1);
  assert.equal(setStep.type, "set");
  assert.equal(setStep.outputs?.assigned, "tests");
  assert.equal(setStep.changes.length, 1);
  assert.deepEqual({ key: setStep.changes[0].key, action: setStep.changes[0].action, after: setStep.changes[0].after }, {
    key: "subject", action: "added", after: "tests"
  });
  assert.equal(setStep.changes[0].sensitive, false);
  assert.ok(setStep.durationMs !== undefined && setStep.durationMs >= 0);
  assert.ok(setStep.startedAt && setStep.finishedAt);

  const logStep = summaryAt(run, 2);
  assert.equal(logStep.outputs?.logged, "Running tests");
  assert.equal(logStep.changes.length, 0);

  const delayStep = summaryAt(run, 3);
  assert.equal(delayStep.outputs?.waitedMs, 25);
  assert.ok(delayStep.durationMs !== undefined && delayStep.durationMs >= 20);
});

test("masks sensitive variable values in summaries and logs", async (t) => {
  const { server, baseUrl } = await startTestServer();
  t.after(() => server.close());

  const run = await createAndRun(baseUrl, [
    { id: "set-secret", type: "set", key: "api_key", value: "supersecretvalue" },
    { id: "log-secret", type: "log", message: "token is {{api_key}}" },
    { id: "copy-secret", type: "set", key: "note", value: "key is {{api_key}}" }
  ]);

  assert.equal(run.status, "completed");
  // The runtime value itself is untouched.
  assert.equal(run.variables.api_key, "supersecretvalue");

  // The secret never appears in any log line.
  assert.ok(run.logs.every((log) => !log.message.includes("supersecretvalue")));
  assert.ok(run.logs.some((log) => log.message.includes(`token is ${MASKED_VALUE}`)));
  assert.ok(run.logs.some((log) => log.message.includes(`Set note = key is ${MASKED_VALUE}`)));

  const secretStep = summaryAt(run, 1);
  assert.equal(secretStep.inputs.value, MASKED_VALUE);
  assert.equal(secretStep.outputs?.assigned, MASKED_VALUE);
  assert.equal(secretStep.changes[0].sensitive, true);
  assert.equal(secretStep.changes[0].after, MASKED_VALUE);

  const logStep = summaryAt(run, 2);
  assert.equal(logStep.outputs?.logged, `token is ${MASKED_VALUE}`);

  const copyStep = summaryAt(run, 3);
  assert.ok(copyStep.outputs?.assigned?.includes(MASKED_VALUE));
  assert.ok(!copyStep.outputs?.assigned?.includes("supersecretvalue"));
  const noteChange = copyStep.changes.find((change) => change.key === "note");
  assert.ok(noteChange && noteChange.after.includes(MASKED_VALUE));
});

test("truncates oversized values in summaries", async (t) => {
  const { server, baseUrl } = await startTestServer();
  t.after(() => server.close());
  const longValue = "x".repeat(500);

  const run = await createAndRun(baseUrl, [
    { id: "set-big", type: "set", key: "big", value: longValue },
    { id: "log-big", type: "log", message: longValue }
  ]);

  const setStep = summaryAt(run, 1);
  assert.ok(setStep.changes[0].after.length < 500);
  assert.ok(setStep.changes[0].after.includes("…"));
  assert.ok(summaryAt(run, 2).outputs?.logged?.includes("…"));
  // The full runtime value is intact.
  assert.equal(run.variables.big, longValue);
});

test("marks the failed step failed and the steps after it skipped", async () => {
  class FailingStore extends WorkflowStore {
    setVariable(id: string, key: string, value: string): void {
      if (key === "boom") throw new Error("Intentional step failure");
      super.setVariable(id, key, value);
    }
  }

  const store = new FailingStore(false);
  const now = new Date().toISOString();
  const workflow: Workflow = {
    id: "fail-workflow",
    name: "Fail workflow",
    description: "",
    steps: [
      { id: "ok", type: "set", key: "first", value: "1" },
      { id: "boom", type: "set", key: "boom", value: "2" },
      { id: "never", type: "log", message: "Should not run" }
    ],
    createdAt: now,
    updatedAt: now
  };
  const run = store.createRun(workflow.id);
  await executeWorkflow(store, workflow, run);

  const fresh = store.getRun(run.id);
  assert.ok(fresh);
  assert.equal(fresh.status, "failed");
  assert.equal(fresh.error, "Intentional step failure");
  assert.equal(summaryAt(fresh, 1).status, "completed");
  const failed = summaryAt(fresh, 2);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "Intentional step failure");
  assert.ok(failed.durationMs !== undefined);
  assert.equal(summaryAt(fresh, 3).status, "skipped");
});

test("a summary-collection failure does not change the workflow status", async () => {
  class BrokenSummaryStore extends WorkflowStore {
    override updateStepSummary(): never {
      throw new Error("Observability backend is down");
    }
  }

  const store = new BrokenSummaryStore(false);
  const now = new Date().toISOString();
  const workflow: Workflow = {
    id: "collection-failure-workflow",
    name: "Collection failure",
    description: "",
    steps: [
      { id: "set-1", type: "set", key: "a", value: "1" },
      { id: "log-1", type: "log", message: "Still runs" }
    ],
    createdAt: now,
    updatedAt: now
  };
  const run = store.createRun(workflow.id);
  await executeWorkflow(store, workflow, run);

  const fresh = store.getRun(run.id);
  assert.ok(fresh);
  assert.equal(fresh.status, "completed");
  assert.equal(fresh.variables.a, "1");
  assert.ok(fresh.logs.some((log) => log.message === "Still runs"));
});

test("serves old runs without step summaries (graceful degradation)", async (t) => {
  const store = new WorkflowStore(false);
  const { server, baseUrl } = await startTestServer(store);
  t.after(() => server.close());

  const workflowResponse = await fetch(`${baseUrl}/api/workflows`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Old run workflow",
      steps: [{ id: "log-1", type: "log", message: "Legacy" }]
    })
  });
  const { workflow } = (await workflowResponse.json()) as { workflow: Workflow };
  const runResponse = await fetch(`${baseUrl}/api/workflows/${workflow.id}/runs`, { method: "POST" });
  const { run } = (await runResponse.json()) as { run: WorkflowRun };
  const finished = await waitForRun(baseUrl, run.id);
  assert.equal(finished.status, "completed");
  assert.ok(finished.stepSummaries && finished.stepSummaries.length === 1);

  // Simulate a run recorded before summaries existed.
  const stored = store.getRun(run.id);
  assert.ok(stored);
  delete stored.stepSummaries;

  const legacyResponse = await fetch(`${baseUrl}/api/runs/${run.id}`);
  assert.equal(legacyResponse.status, 200);
  const { run: legacy } = (await legacyResponse.json()) as { run: WorkflowRun };
  assert.equal(legacy.stepSummaries, undefined);
  assert.ok(legacy.logs.length > 0);
});
