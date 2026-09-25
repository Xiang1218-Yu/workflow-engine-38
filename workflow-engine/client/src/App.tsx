import { useEffect, useMemo, useState } from "react";
import type { CreateWorkflowInput, StepType, Workflow, WorkflowRun, WorkflowStep } from "../../shared/types";
import { api } from "./api";
import { StepTimeline } from "./StepTimeline";

const emptySteps: WorkflowStep[] = [{ id: crypto.randomUUID(), type: "log", message: "Hello from my workflow" }];

function newStep(type: StepType): WorkflowStep {
  const id = crypto.randomUUID();
  if (type === "log") return { id, type, message: "Write something to the run log" };
  if (type === "set") return { id, type, key: "key", value: "value" };
  return { id, type, durationMs: 500 };
}

export function App() {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [name, setName] = useState("Untitled workflow");
  const [description, setDescription] = useState("");
  const [steps, setSteps] = useState<WorkflowStep[]>(emptySteps);
  const [run, setRun] = useState<WorkflowRun>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [showAllLogs, setShowAllLogs] = useState(false);

  const selected = useMemo(() => workflows.find((workflow) => workflow.id === selectedId), [selectedId, workflows]);
  const visibleLogs = useMemo(() => {
    if (!run || showAllLogs) return run?.logs ?? [];
    // Long log tails are rendered on demand so polling a chatty run cannot freeze the page.
    return run.logs.slice(-200);
  }, [run, showAllLogs]);

  useEffect(() => {
    setShowAllLogs(false);
  }, [run?.id]);

  useEffect(() => {
    api.listWorkflows().then(({ workflows: loaded }) => {
      setWorkflows(loaded);
      if (loaded[0]) selectWorkflow(loaded[0]);
    }).catch((err: Error) => setError(err.message)).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!run || (run.status !== "queued" && run.status !== "running")) return;
    const timer = window.setInterval(() => {
      api.getRun(run.id).then(({ run: latest }) => setRun(latest)).catch((err: Error) => setError(err.message));
    }, 350);
    return () => window.clearInterval(timer);
  }, [run]);

  function selectWorkflow(workflow: Workflow) {
    setSelectedId(workflow.id);
    setName(workflow.name);
    setDescription(workflow.description);
    setSteps(workflow.steps);
    setRun(undefined);
    setError("");
  }

  function startNewWorkflow() {
    setSelectedId(undefined);
    setName("Untitled workflow");
    setDescription("");
    setSteps([newStep("log")]);
    setRun(undefined);
    setError("");
  }

  function updateStep(index: number, patch: Partial<WorkflowStep>) {
    setSteps((current) => current.map((step, stepIndex) => stepIndex === index ? ({ ...step, ...patch } as WorkflowStep) : step));
  }

  async function saveWorkflow() {
    setSaving(true);
    setError("");
    try {
      const input: CreateWorkflowInput = { name, description, steps };
      const { workflow } = await api.createWorkflow(input);
      setWorkflows((current) => [workflow, ...current]);
      selectWorkflow(workflow);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save workflow");
    } finally {
      setSaving(false);
    }
  }

  async function runWorkflow() {
    if (!selectedId) {
      setError("Save the workflow before running it.");
      return;
    }
    setError("");
    try {
      const { run: createdRun } = await api.runWorkflow(selectedId);
      setRun(createdRun);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start workflow");
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">◎</span><div><strong>FlowFoundry</strong><small>CONFIGURABLE AUTOMATION</small></div></div>
        <div className="topbar-actions"><span className="api-status"><i /> API connected</span><button className="button ghost" onClick={startNewWorkflow}>＋ New workflow</button></div>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <div className="sidebar-heading"><span>WORKFLOWS</span><button className="icon-button" onClick={startNewWorkflow} aria-label="Create workflow">＋</button></div>
          {loading && <p className="muted">Loading workflows…</p>}
          {!loading && workflows.length === 0 && <p className="muted">No workflows yet.</p>}
          <div className="workflow-list">
            {workflows.map((workflow) => <button key={workflow.id} className={`workflow-item ${selectedId === workflow.id ? "active" : ""}`} onClick={() => selectWorkflow(workflow)}><span className="workflow-dot" /><span><strong>{workflow.name}</strong><small>{workflow.steps.length} steps</small></span></button>)}
          </div>
          <div className="sidebar-footer"><span className="shortcut">⌘ K</span> Keyboard shortcuts</div>
        </aside>

        <section className="content">
          <div className="page-heading"><div><p className="eyebrow">WORKFLOW BUILDER</p><h1>{selected ? selected.name : "New workflow"}</h1><p className="subheading">Compose deterministic steps, then run and inspect them in real time.</p></div><div className="heading-actions"><button className="button secondary" onClick={saveWorkflow} disabled={saving}>{saving ? "Saving…" : "Save workflow"}</button><button className="button primary" onClick={runWorkflow}>▶ Run workflow</button></div></div>
          {error && <div className="alert">{error}</div>}

          <div className="builder-grid">
            <div className="builder-card">
              <div className="card-title"><div><span className="step-number">01</span><h2>Details</h2></div><span className="card-hint">IDENTITY</span></div>
              <label>Workflow name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Daily digest" /></label>
              <label>Description <span className="optional">optional</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What does this workflow automate?" rows={3} /></label>
            </div>

            <div className="builder-card steps-card">
              <div className="card-title"><div><span className="step-number">02</span><h2>Steps</h2></div><span className="card-hint">RUN IN ORDER</span></div>
              <div className="steps-list">
                {steps.map((step, index) => <div className="step-row" key={step.id}><div className="drag-handle">⠿</div><div className="step-index">{String(index + 1).padStart(2, "0")}</div><div className="step-editor"><div className="step-header"><select value={step.type} onChange={(event) => updateStep(index, newStep(event.target.value as StepType))}><option value="log">log · Write to run log</option><option value="set">set · Save a variable</option><option value="delay">delay · Pause execution</option></select><button className="remove" onClick={() => setSteps((current) => current.filter((_, stepIndex) => stepIndex !== index))} aria-label={`Remove step ${index + 1}`}>×</button></div>{step.type === "log" && <input value={step.message} onChange={(event) => updateStep(index, { message: event.target.value })} placeholder="Message (supports {{variable}})" />}{step.type === "set" && <div className="inline-fields"><input value={step.key} onChange={(event) => updateStep(index, { key: event.target.value })} placeholder="Variable name" /><input value={step.value} onChange={(event) => updateStep(index, { value: event.target.value })} placeholder="Value" /></div>}{step.type === "delay" && <label className="compact-label">Duration in milliseconds<input type="number" min={0} max={60000} value={step.durationMs} onChange={(event) => updateStep(index, { durationMs: Number(event.target.value) })} /></label>}</div></div>)}
              </div>
              <div className="add-step-row"><span className="connector" /><button className="add-step" onClick={() => setSteps((current) => [...current, newStep("log")])}>＋ Add step</button><span className="step-count">{steps.length} {steps.length === 1 ? "step" : "steps"}</span></div>
            </div>
          </div>

          <section className="run-card">
            <div className="run-header">
              <div>
                <p className="eyebrow">OBSERVABILITY</p>
                <h2>Latest run</h2>
              </div>
              {run ? <span className={`status ${run.status}`}><i /> {run.status}</span> : <span className="status idle"><i /> not started</span>}
            </div>
            {run ? (
              <div className="run-content">
                <div className="run-meta">
                  <span>RUN ID <strong>{run.id.slice(0, 8)}…</strong></span>
                  <span>STARTED <strong>{new Date(run.startedAt).toLocaleTimeString()}</strong></span>
                  <span>VARIABLES <strong>{Object.keys(run.variables).length}</strong></span>
                </div>

                <StepTimeline steps={selected?.steps ?? steps} run={run} />

                <div className="log-console">
                  {!showAllLogs && run.logs.length > 200 && (
                    <button className="log-more" onClick={() => setShowAllLogs(true)}>
                      还有 {run.logs.length - 200} 条更早的日志，点击全部加载
                    </button>
                  )}
                  {visibleLogs.map((log, index) => (
                    <div className={`log-line ${log.level}`} key={`${log.at}-${index}`}>
                      <time>{new Date(log.at).toLocaleTimeString()}</time>
                      <span className="log-bullet">{log.level === "error" ? "!" : "›"}</span>
                      <span>{log.message}</span>
                    </div>
                  ))}
                  {run.logs.length === 0 && <span className="muted">Waiting for execution…</span>}
                </div>
              </div>
            ) : (
              <div className="empty-run">
                <span className="pulse">◌</span>
                <p>Run this workflow to see live execution logs and variables.</p>
              </div>
            )}
          </section>
        </section>
      </div>
    </main>
  );
}
