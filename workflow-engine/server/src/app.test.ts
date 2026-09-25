import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "./app.js";
import type { StepSummary } from "../../shared/types.js";
import { WorkflowStore } from "./store.js";

async function startTestServer() {
  const server = createApp(new WorkflowStore(false));
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
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

async function createAndRun(
  baseUrl: string,
  steps: Array<Record<string, unknown>>
): Promise<{ run: { status: string; stepSummaries?: StepSummary[]; logs: Array<{ message: string }>; variables: Record<string, string>; error?: string } }> {
  const createResponse = await fetch(`${baseUrl}/api/workflows`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Summary workflow", steps })
  });
  assert.equal(createResponse.status, 201);
  const { workflow } = (await createResponse.json()) as { workflow: { id: string } };

  const runResponse = await fetch(`${baseUrl}/api/workflows/${workflow.id}/runs`, { method: "POST" });
  assert.equal(runResponse.status, 202);
  const { run: started } = (await runResponse.json()) as { run: { id: string } };

  let body: { run: { status: string; stepSummaries?: StepSummary[]; logs: Array<{ message: string }>; variables: Record<string, string>; error?: string } };
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 15));
    body = (await (await fetch(`${baseUrl}/api/runs/${started.id}`)).json()) as typeof body;
    if (body.run.status === "completed" || body.run.status === "failed") break;
  }
  return body!;
}

test("records ordered step summaries with timing and variable changes", async (t) => {
  const { server, baseUrl } = await startTestServer();
  t.after(() => server.close());

  const { run } = await createAndRun(baseUrl, [
    { id: "set-name", type: "set", key: "name", value: "Ada" },
    { id: "delay-1", type: "delay", durationMs: 25 },
    { id: "log-hello", type: "log", message: "Hello {{name}}" }
  ]);

  assert.equal(run.status, "completed");
  assert.ok(run.stepSummaries, "new runs carry step summaries");
  assert.deepEqual(run.stepSummaries!.map((entry) => entry.stepId), ["set-name", "delay-1", "log-hello"]);
  assert.deepEqual(run.stepSummaries!.map((entry) => entry.order), [1, 2, 3]);

  const setStep = run.stepSummaries![0];
  assert.equal(setStep.status, "completed");
  assert.equal(setStep.changes[0].key, "name");
  assert.equal(setStep.changes[0].kind, "added");
  assert.equal(setStep.changes[0].after.text, "Ada");
  assert.equal(setStep.outputPreview?.text, "Ada");
  assert.ok(typeof setStep.durationMs === "number");

  const delayStep = run.stepSummaries![1];
  assert.equal(delayStep.status, "completed");
  assert.equal(delayStep.inputPreview?.text, "25 ms");
  assert.ok((delayStep.durationMs ?? 0) >= 20, "delay duration is measured");

  const logStep = run.stepSummaries![2];
  assert.equal(logStep.outputPreview?.text, "Hello Ada");
  assert.deepEqual(logStep.changes, []);
});

test("redacts sensitive variable values in summaries, logs, and the API variables map", async (t) => {
  const { server, baseUrl } = await startTestServer();
  t.after(() => server.close());

  const { run } = await createAndRun(baseUrl, [
    { id: "set-token", type: "set", key: "api_token", value: "super-secret-value" },
    { id: "leak-log", type: "log", message: "Token is {{api_token}}" },
    { id: "safe-set", type: "set", key: "user", value: "Grace" }
  ]);

  assert.equal(run.status, "completed");
  const setToken = run.stepSummaries![0];
  assert.equal(setToken.outputPreview?.redacted, true);
  assert.equal(setToken.outputPreview?.text, "********");
  assert.equal(setToken.outputPreview?.length, "super-secret-value".length);
  assert.equal(setToken.changes[0].after.redacted, true);
  assert.ok(!JSON.stringify(setToken).includes("super-secret-value"));

  const leakLog = run.stepSummaries![1];
  assert.equal(leakLog.outputPreview?.text, "Token is ********");
  assert.ok(!run.logs.some((log) => log.message.includes("super-secret-value")), "raw secret must never reach the log");

  // The runtime value is masked at the HTTP boundary too: interpolation still
  // worked (see the rendered log above) but the variables map exposes no secret.
  assert.equal(run.variables.api_token, "********");
  assert.ok(!JSON.stringify(run).includes("super-secret-value"));
});

test("marks the failing step failed and later steps skipped", async (t) => {
  // Validation rejects unknown step types, so seed the store directly with a
  // workflow containing an unsupported step type and drive a normal run request.
  const store = new WorkflowStore(false);
  const now = new Date().toISOString();
  (store as unknown as { workflows: Map<string, unknown> }).workflows.set("broken-workflow", {
    id: "broken-workflow",
    name: "Broken workflow",
    description: "",
    createdAt: now,
    updatedAt: now,
    steps: [
      { id: "ok-1", type: "log", message: "before" },
      { id: "boom", type: "explode" },
      { id: "never", type: "log", message: "after" }
    ]
  });

  const server = createApp(store);
  server.listen(0);
  t.after(() => server.close());
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const runResponse = await fetch(`${baseUrl}/api/workflows/broken-workflow/runs`, { method: "POST" });
  assert.equal(runResponse.status, 202);
  const { run: started } = (await runResponse.json()) as { run: { id: string } };

  let failedRun: { status: string; stepSummaries?: StepSummary[]; error?: string };
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 15));
    failedRun = (await (await fetch(`${baseUrl}/api/runs/${started.id}`)).json() as { run: typeof failedRun }).run;
    if (failedRun!.status === "failed") break;
  }
  assert.equal(failedRun!.status, "failed");
  assert.ok(failedRun!.error?.includes("explode"));
  const statuses = Object.fromEntries(failedRun!.stepSummaries!.map((entry) => [entry.stepId, entry.status]));
  assert.deepEqual(statuses, { "ok-1": "completed", boom: "failed", never: "skipped" });
});

test("telemetry collection failures do not change workflow state", async (t) => {
  // Store whose summary telemetry throws on every call: execution must still complete.
  class FlakyStore extends WorkflowStore {
    constructor() {
      super(false);
    }
    override startStepSummary(): boolean {
      throw new Error("telemetry unavailable");
    }
    override updateStepSummary(): boolean {
      throw new Error("telemetry unavailable");
    }
    override markStepsSkipped(): void {
      throw new Error("telemetry unavailable");
    }
  }

  const store = new FlakyStore();
  const now = new Date().toISOString();
  (store as unknown as { workflows: Map<string, unknown> }).workflows.set("flaky-workflow", {
    id: "flaky-workflow",
    name: "Flaky telemetry",
    description: "",
    createdAt: now,
    updatedAt: now,
    steps: [
      { id: "set-1", type: "set", key: "name", value: "Ada" },
      { id: "log-1", type: "log", message: "Hello {{name}}" }
    ]
  });

  const server = createApp(store);
  server.listen(0);
  t.after(() => server.close());
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const runResponse = await fetch(`${baseUrl}/api/workflows/flaky-workflow/runs`, { method: "POST" });
  assert.equal(runResponse.status, 202);
  const { run: started } = (await runResponse.json()) as { run: { id: string } };

  let completedRun: { status: string; variables: Record<string, string>; logs: Array<{ message: string }> };
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 15));
    completedRun = (await (await fetch(`${baseUrl}/api/runs/${started.id}`)).json() as { run: typeof completedRun }).run;
    if (completedRun!.status === "completed") break;
  }
  assert.equal(completedRun!.status, "completed");
  assert.equal(completedRun!.variables.name, "Ada");
  assert.ok(completedRun!.logs.some((log) => log.message === "Hello Ada"));
});
