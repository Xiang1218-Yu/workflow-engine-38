import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { executeWorkflow } from "./engine.js";
import { validateSteps, WorkflowStore } from "./store.js";
import { isSensitiveKey } from "./telemetry.js";
import type { CreateWorkflowInput, WorkflowRun } from "../../shared/types.js";

const jsonHeaders = { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" };

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, jsonHeaders);
  res.end(JSON.stringify(body));
}

/**
 * API-facing view of a run. The engine keeps real variable values internally so
 * {{interpolation}} keeps working, but sensitive values are masked at the HTTP
 * boundary so they never reach the client.
 */
function serializeRun(run: WorkflowRun): WorkflowRun {
  const variables: Record<string, string> = {};
  for (const [key, value] of Object.entries(run.variables)) {
    variables[key] = isSensitiveKey(key) ? "********" : value;
  }
  return { ...run, variables };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function pathParts(url: string | undefined): string[] {
  return (url ?? "").split("?")[0].split("/").filter(Boolean);
}

export function createApp(store = new WorkflowStore()) {
  return createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const parts = pathParts(req.url);
    if (parts[0] !== "api") return send(res, 404, { error: "Not found" });

    try {
      if (req.method === "GET" && parts.length === 2 && parts[1] === "workflows") {
        return send(res, 200, { workflows: store.listWorkflows() });
      }

      if (req.method === "POST" && parts.length === 2 && parts[1] === "workflows") {
        const body = (await readJson(req)) as Partial<CreateWorkflowInput>;
        if (typeof body.name !== "string" || body.name.trim().length === 0 || !validateSteps(body.steps)) {
          return send(res, 400, { error: "name and a valid non-empty steps array are required" });
        }
        const workflow = store.createWorkflow({ name: body.name, description: body.description, steps: body.steps });
        return send(res, 201, { workflow });
      }

      if (parts[1] === "workflows" && parts[2]) {
        const workflow = store.getWorkflow(parts[2]);
        if (!workflow) return send(res, 404, { error: "Workflow not found" });

        if (req.method === "GET" && parts.length === 3) return send(res, 200, { workflow });
        if (req.method === "GET" && parts.length === 4 && parts[3] === "runs") {
          return send(res, 200, { runs: store.listRuns(workflow.id).map(serializeRun) });
        }
        if (req.method === "POST" && parts.length === 4 && parts[3] === "runs") {
          const run = store.createRun(workflow.id);
          void executeWorkflow(store, workflow, run);
          return send(res, 202, { run: serializeRun(run) });
        }
      }

      if (req.method === "GET" && parts.length === 3 && parts[1] === "runs") {
        const run = store.getRun(parts[2]);
        return run ? send(res, 200, { run: serializeRun(run) }) : send(res, 404, { error: "Run not found" });
      }

      return send(res, 404, { error: "Not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected server error";
      return send(res, 400, { error: message });
    }
  });
}
