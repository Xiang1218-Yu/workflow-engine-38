import { memo, useEffect, useMemo, useState } from "react";
import type {
  StepSummary,
  StepSummaryStatus,
  ValuePreview,
  VariableChange,
  WorkflowRun,
  WorkflowStep
} from "../../shared/types";

const PAGE_SIZE = 50;

const STATUS_LABEL: Record<StepSummaryStatus, string> = {
  running: "执行中",
  waiting: "等待中",
  pending: "待执行",
  completed: "已完成",
  failed: "失败",
  skipped: "未执行"
};

const STEP_TYPE_LABEL: Record<WorkflowStep["type"], string> = {
  log: "log · 日志",
  set: "set · 变量",
  delay: "delay · 等待"
};

interface StepRow {
  stepId: string;
  order: number;
  type: WorkflowStep["type"];
  status: StepSummaryStatus | "unknown";
  summary?: StepSummary;
}

/**
 * Merge the workflow definition with per-step telemetry. Definition order is the
 * actual execution order (steps run sequentially), and summaries may be missing
 * for old runs or when telemetry collection failed.
 */
function buildRows(steps: WorkflowStep[], run: WorkflowRun): StepRow[] {
  const byId = new Map(run.stepSummaries?.map((summary) => [summary.stepId, summary]) ?? []);
  return steps.map((step, index) => {
    const summary = byId.get(step.id);
    if (summary) {
      return { stepId: step.id, order: summary.order, type: summary.type ?? step.type, status: summary.status, summary };
    }
    // Legacy run without summaries, or a lost telemetry record: infer a coarse status.
    let status: StepRow["status"] = "unknown";
    const summaries = run.stepSummaries ?? [];
    const failed = summaries.find((entry) => entry.status === "failed");
    if (run.status === "completed") status = "completed";
    else if (failed && index + 1 > failed.order) status = "skipped";
    else if (run.status === "failed" && failed && index + 1 === failed.order) status = "failed";
    else if (run.status === "running" || run.status === "queued") status = index < summaries.length ? "completed" : "pending";
    return { stepId: step.id, order: index + 1, type: step.type, status };
  });
}

function stepTitle(step: WorkflowStep): string {
  if (step.type === "log") return step.message;
  if (step.type === "set") return `${step.key} = ${step.value}`;
  return `等待 ${step.durationMs} ms`;
}

function Preview({ preview }: { preview: ValuePreview }) {
  return (
    <code className="preview-value">
      {preview.text}
      {preview.truncated && <span className="preview-note">（已截断，共 {preview.length} 字符）</span>}
      {preview.redacted && <span className="preview-note">（已脱敏，共 {preview.length} 字符）</span>}
    </code>
  );
}

function Changes({ changes }: { changes: VariableChange[] }) {
  if (changes.length === 0) return <p className="muted">本步骤没有修改变量。</p>;
  return (
    <ul className="change-list">
      {changes.map((change) => (
        <li key={change.key} className={`change ${change.kind}`}>
          <span className="change-kind">{change.kind === "added" ? "新增" : "更新"}</span>
          <code className="change-key">{change.key}</code>
          {change.before && (
            <>
              <Preview preview={change.before} />
              <span className="change-arrow">→</span>
            </>
          )}
          <Preview preview={change.after} />
        </li>
      ))}
    </ul>
  );
}

interface RowProps {
  step: WorkflowStep;
  row: StepRow;
  expanded: boolean;
  onToggle: (stepId: string) => void;
}

const StepRowView = memo(function StepRowView({ step, row, expanded, onToggle }: RowProps) {
  const { summary } = row;
  const expandable = Boolean(summary);
  return (
    <li className={`timeline-row status-${row.status} ${expanded ? "expanded" : ""}`}>
      <button
        className="timeline-head"
        onClick={() => expandable && onToggle(row.stepId)}
        disabled={!expandable}
        aria-expanded={expanded}
      >
        <span className="timeline-icon" aria-hidden="true">
          {row.status === "waiting" ? "◷" : row.status === "failed" ? "✕" : row.status === "skipped" ? "○" : row.status === "pending" ? "◌" : row.status === "running" ? "◐" : row.status === "unknown" ? "·" : "✓"}
        </span>
        <span className="timeline-order">{String(row.order).padStart(2, "0")}</span>
        <span className="timeline-type">{STEP_TYPE_LABEL[row.type] ?? step.type}</span>
        <span className="timeline-title" title={stepTitle(step)}>{stepTitle(step)}</span>
        <span className={`timeline-status ${row.status}`}>
          {row.status === "unknown" ? "无摘要" : STATUS_LABEL[row.status as StepSummaryStatus]}
        </span>
        {typeof summary?.durationMs === "number" && row.status !== "skipped" && (
          <span className="timeline-duration">{summary.durationMs} ms</span>
        )}
        {expandable && <span className="timeline-chevron" aria-hidden="true">{expanded ? "▾" : "▸"}</span>}
      </button>

      {expanded && summary && (
        <div className="timeline-detail">
          <div className="detail-grid">
            <div>
              <p className="detail-label">输入摘要</p>
              {summary.inputPreview ? <Preview preview={summary.inputPreview} /> : <span className="muted">无</span>}
            </div>
            <div>
              <p className="detail-label">输出摘要</p>
              {summary.outputPreview ? <Preview preview={summary.outputPreview} /> : <span className="muted">无</span>}
            </div>
          </div>
          <p className="detail-label">
            变量变化
            {typeof summary.durationMs === "number" && <span className="detail-time">耗时 {summary.durationMs} ms</span>}
          </p>
          <Changes changes={summary.changes} />
          {summary.error && <div className="detail-error">错误：{summary.error}</div>}
        </div>
      )}
    </li>
  );
});

export function StepTimeline({ steps, run }: { steps: WorkflowStep[]; run: WorkflowRun }) {
  const rows = useMemo(() => buildRows(steps, run), [steps, run]);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  // Reset expansion and paging whenever a different run is inspected.
  useEffect(() => {
    setExpanded(new Set());
    setVisibleCount(PAGE_SIZE);
  }, [run.id]);

  // While polling, keep the tail (most recent progress) reachable without resetting manual expansion.
  const visibleRows = rows.slice(0, visibleCount);
  const hasSummary = (run.stepSummaries?.length ?? 0) > 0;

  function toggle(stepId: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(stepId)) next.delete(stepId);
      else next.add(stepId);
      return next;
    });
  }

  return (
    <div className="timeline-card">
      <div className="timeline-heading">
        <p className="eyebrow">STEP TIMELINE</p>
        <h3>步骤执行详情</h3>
        <p className="subheading">按实际执行顺序展开任意步骤，查看输入/输出摘要与变量变化。</p>
      </div>

      {!hasSummary && (
        <div className="timeline-legacy-note">
          该运行产生于摘要功能上线之前（或摘要采集未成功），以下仅展示步骤定义与推断状态，无法展开输入/输出详情。
        </div>
      )}

      {rows.length === 0 && <p className="muted">该工作流没有步骤。</p>}

      <ul className="timeline-list">
        {visibleRows.map((row) => {
          const step = steps.find((candidate) => candidate.id === row.stepId);
          if (!step) return null;
          return (
            <StepRowView
              key={row.stepId}
              step={step}
              row={row}
              expanded={expanded.has(row.stepId)}
              onToggle={toggle}
            />
          );
        })}
      </ul>

      {visibleCount < rows.length && (
        <button className="timeline-more" onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>
          再显示 {Math.min(PAGE_SIZE, rows.length - visibleCount)} 步（共 {rows.length} 步）
        </button>
      )}
    </div>
  );
}
