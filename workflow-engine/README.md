# Workflow Engine

A small but extensible configurable automation workflow engine built with React + Vite + TypeScript on the frontend and Node.js + TypeScript on the backend. It is intentionally split into small layers so future GSB tasks can add step types, persistence, authentication, queues, or richer editors without rewriting the baseline.

## Features

- List workflows and create new workflows in the UI.
- Configure ordered `log`, `set`, and `delay` steps.
- Execute a saved workflow through the API.
- In-memory workflow/run storage with seeded example data.
- Live run status, variables, and execution log polling in the UI.
- Expandable per-step timeline with input/output summaries, before/after variable diffs, timing, and distinct states for running, delay-waiting, pending, failed, and skipped steps.
- Sensitive variable values (keys matching tokens, passwords, secrets, API keys, …) are redacted in summaries, logs, and API responses; long values are truncated.
- Lightweight Node `http` server with no runtime backend dependency.
- Basic API tests using Node's built-in test runner.

## Structure

```text
workflow-engine/
├── client/              # React + Vite UI
│   ├── src/App.tsx      # Builder and run inspector
│   ├── src/api.ts       # Typed API client
│   └── src/styles.css
├── server/
│   ├── src/app.ts       # HTTP API and routing
│   ├── src/engine.ts    # Step execution engine
│   ├── src/store.ts     # In-memory repository and validation
│   └── src/app.test.ts  # API/integration tests
├── shared/types.ts      # Shared workflow and run contracts
└── package.json
```

## Run locally

Requirements: Node.js 20+.

```bash
npm install
npm run dev
```

Open <http://localhost:5173>. The API runs on <http://localhost:3001> and Vite proxies `/api` requests to it.

Useful commands:

```bash
npm test       # API integration tests
npm run typecheck
npm run build  # Compile server and build Vite client
npm start      # Start compiled API (after npm run build)
```

## API

- `GET /api/workflows` — list workflows
- `POST /api/workflows` — create `{ name, description?, steps }`
- `GET /api/workflows/:id` — get one workflow
- `GET /api/workflows/:id/runs` — list runs for a workflow
- `POST /api/workflows/:id/runs` — start an asynchronous run
- `GET /api/runs/:id` — inspect status, logs, variables, and step summaries

## Run telemetry

Each run records a `stepSummaries` array (one entry per step, in execution order) containing the
step status (`running`, `waiting` for an in-progress delay, `completed`, `failed`, `skipped`),
`durationMs`, redacted/truncated input and output previews, and the variables added or updated by
the step. The UI merges these summaries with the workflow definition; runs created before this
feature (or whose telemetry collection failed) degrade to definition-only rows with inferred
status and no expandable details. Summary collection is best-effort and can never change the
workflow's execution status. The timeline is paginated (50 steps at a time) and previews are
capped at 160 characters so long runs and large values do not freeze the page.

Example step payload:

```json
[
  { "id": "step-1", "type": "set", "key": "name", "value": "Ada" },
  { "id": "step-2", "type": "log", "message": "Hello {{name}}" },
  { "id": "step-3", "type": "delay", "durationMs": 250 }
]
```

## Extension points

- Add a new `StepType` and union member in `shared/types.ts`.
- Implement its execution behavior in `server/src/engine.ts`.
- Extend validation in `server/src/store.ts`.
- Add an editor branch in `client/src/App.tsx`.
- Replace `WorkflowStore` with a database-backed repository while keeping the HTTP contract stable.

The current store is intentionally in-memory; restarting the server resets data.
