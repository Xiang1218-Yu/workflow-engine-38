import { useMemo, useState } from "react";
import type { StepRunStatus, StepRunSummary, VariableChange } from "../../shared/types";

/** Steps are revealed in batches so workflows with hundreds of steps never render thousands of DOM nodes at once. */
const REVEAL_BATCH = 50;

const STATUS_META: Record<StepRunStatus, { icon: string; label: string }> = {
  pending: { icon: "○", label: "Pending" },
  running: { icon: "◐", label: "Running" },
  waiting: { icon: "⏳", label: "Waiting" },
  completed: { icon: "✓", label: "Completed" },
  failed: { icon: "✕", label: "Failed" },
  skipped: { icon: "⊘", label: "Skipped" }
};

const INPUT_LABELS: Record<string, string> = {
  requestedDurationMs: "Requested duration (ms)",
  effectiveDurationMs: "Effective duration (ms)"
};

const OUTPUT_LABELS: Record<string, string> = {
  logged: "Logged message",
  assigned: "Assigned value",
  waitedMs: "Waited (ms)"
};

function formatDuration(durationMs: number): string {
  return durationMs < 1000 ? `${durationMs} ms` : `${(durationMs / 1000).toFixed(2)} s`;
}

function changeSymbol(action: VariableChange["action"]): string {
  if (action === "added") return "+";
  if (action === "updated") return "~";
  return "=";
}

function StepChanges({ summary }: { summary: StepRunSummary }) {
  if (summary.changes.length === 0) {
    return (
      <div className="step-detail-block">
        <h4>Variable changes</h4>
        <p className="muted">No variables changed by this step.</p>
      </div>
    );
  }
  return (
    <div className="step-detail-block">
      <h4>Variable changes</h4>
      <ul className="change-list">
        {summary.changes.map((change) => (
          <li key={change.key} className={`change-row ${change.action}`}>
            <span className="change-symbol">{changeSymbol(change.action)}</span>
            <code className="change-key">{change.key}</code>
            {change.sensitive ? (
              <span className="sensitive-badge" title="Value hidden because the variable name looks sensitive">🔒 sensitive · value hidden</span>
            ) : (
              <span className="change-values">
                {change.action === "updated" && <><s title="Before">{change.before}</s><span className="change-arrow">→</span></>}
                <strong title="After">{change.after}</strong>
              </span>
            )}
          </li>
        ))}
      </ul>
      {summary.changesTruncated && <p className="muted">Only the first {summary.changes.length} changes are shown.</p>}
    </div>
  );
}

function StepDetail({ summary }: { summary: StepRunSummary }) {
  const inputs = Object.entries(summary.inputs);
  const outputs = Object.entries(summary.outputs ?? {});
  return (
    <div className="step-detail">
      <div className="step-detail-block">
        <h4>Inputs</h4>
        {inputs.length === 0 ? <p className="muted">No inputs.</p> : (
          <dl className="kv-list">
            {inputs.map(([key, value]) => (
              <div className="kv-row" key={key}>
                <dt>{INPUT_LABELS[key] ?? key}</dt>
                <dd title={value}>{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      <div className="step-detail-block">
        <h4>Outputs</h4>
        {summary.error && <p className="step-error">{summary.error}</p>}
        {outputs.length === 0 && !summary.error && <p className="muted">No outputs recorded.</p>}
        {outputs.length > 0 && (
          <dl className="kv-list">
            {outputs.map(([key, value]) => (
              <div className="kv-row" key={key}>
                <dt>{OUTPUT_LABELS[key] ?? key}</dt>
                <dd title={value}>{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      <StepChanges summary={summary} />
    </div>
  );
}

export function StepTimeline({ summaries }: { summaries: StepRunSummary[] }) {
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [revealed, setRevealed] = useState(REVEAL_BATCH);

  const ordered = useMemo(() => [...summaries].sort((a, b) => a.position - b.position), [summaries]);
  const visible = ordered.slice(0, revealed);
  const hiddenCount = ordered.length - visible.length;

  return (
    <div className="step-timeline">
      <div className="timeline-heading">
        <span>STEPS</span>
        <span className="timeline-count">{ordered.length} in execution order</span>
      </div>
      <ol className="timeline-list">
        {visible.map((summary) => {
          const meta = STATUS_META[summary.status];
          const expandable = summary.status !== "pending" && summary.status !== "skipped";
          const isOpen = Boolean(expanded[summary.position]);
          return (
            <li key={summary.position} className={`timeline-step ${summary.status} ${isOpen ? "open" : ""}`}>
              <button
                type="button"
                className="timeline-row"
                disabled={!expandable}
                aria-expanded={expandable ? isOpen : undefined}
                onClick={() => setExpanded((current) => ({ ...current, [summary.position]: !current[summary.position] }))}
              >
                <span className="steplier">
                  <span className={`step-icon ${summary.status}`}>{meta.icon}</span>
                </span>
                <span className="step-position">{String(summary.position).padStart(2, "0")}</span>
                <span className="step-type">{summary.type}</span>
                <span className="step-label" title={summary.label}>{summary.label}</span>
                {summary.changes.length > 0 ? <span className="changes-chip">{summary.changesTruncated ? `${summary.changes.length}+` : summary.changes.length} Δ</span> : <span />}
                <span className="step-meta">
                  {summary.durationMs !== undefined && <span className="step-duration">{formatDuration(summary.durationMs)}</span>}
                  <span className={`step-status ${summary.status}`}>{meta.label}</span>
                  {expandable && <span className="chevron">{isOpen ? "▾" : "▸"}</span>}
                </span>
              </button>
              {isOpen && expandable && <StepDetail summary={summary} />}
            </li>
          );
        })}
      </ol>
      {hiddenCount > 0 && (
        <button type="button" className="show-more" onClick={() => setRevealed((count) => count + REVEAL_BATCH)}>
          Show {Math.min(REVEAL_BATCH, hiddenCount)} more · {hiddenCount} remaining
        </button>
      )}
    </div>
  );
}
