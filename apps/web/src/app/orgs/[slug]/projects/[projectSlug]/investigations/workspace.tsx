"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Finding, Investigation, InvestigationResult, Page } from "@/lib/investigations";
import { moreFindings, resultForRun, runsForFinding, startInvestigation } from "./actions";
import { ResultView } from "./result-view";

/** What the page shows for the run whose summary was requested. */
type Summary =
  | { runId: string; state: "loading" }
  | { runId: string; state: "missing" }
  | { runId: string; state: "error"; correlationId: string }
  | { runId: string; state: "ready"; data: InvestigationResult };

const active = (run: Investigation) => run.status === "queued" || run.status === "running";
const failureText = (code: string | null) =>
  ({
    provider_unavailable: "The local model was unavailable.",
    provider_timeout: "The local model timed out.",
    provider_rejected: "The local model rejected the request.",
    invalid_output: "The local model returned an unusable response.",
    processing_error: "Processing failed.",
    attempts_exhausted: "Processing stopped after repeated worker interruptions.",
  })[code ?? ""] ?? "Processing failed.";

function FindingPicker({
  findings,
  selectedId,
  hasMore,
  choose,
  loadMore,
}: {
  findings: Finding[];
  selectedId?: string;
  hasMore: boolean;
  choose: (finding: Finding) => void;
  loadMore: () => void;
}) {
  return (
    <section>
      <h2>Findings</h2>
      {findings.length === 0 && <p>No findings yet.</p>}
      <ul data-testid="investigation-findings">
        {findings.map((finding) => (
          <li key={finding.id}>
            <button
              type="button"
              onClick={() => choose(finding)}
              aria-pressed={selectedId === finding.id}
            >
              {finding.vulnerability.sourceId} · {finding.purl}
            </button>{" "}
            {finding.status === "resolved"
              ? "Resolved"
              : finding.matchQuality === "unverifiable"
                ? "Unverifiable match"
                : "Open"}
          </li>
        ))}
      </ul>
      {hasMore && (
        <button type="button" onClick={loadMore}>
          More findings
        </button>
      )}
    </section>
  );
}

function RunHistory({
  runs,
  hasMore,
  loadMore,
  viewSummary,
}: {
  runs: Investigation[];
  hasMore: boolean;
  loadMore: () => void;
  viewSummary: (run: Investigation) => void;
}) {
  return (
    <>
      <h3>All runs</h3>
      {runs.length === 0 ? (
        <p>No investigations yet.</p>
      ) : (
        <ul data-testid="investigation-runs">
          {runs.map((run) => (
            <li key={run.id}>
              <strong>{run.status}</strong> · {new Date(run.createdAt).toLocaleString()}
              {run.status === "failed" && <span> · {failureText(run.failureCode)}</span>}
              {run.status === "completed" && (
                <>
                  {" · "}
                  <button type="button" onClick={() => viewSummary(run)}>
                    View summary
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {hasMore && (
        <button type="button" onClick={loadMore}>
          More runs
        </button>
      )}
    </>
  );
}

function StartControl({
  finding,
  activeRun,
  busy,
  start,
}: {
  finding: Finding;
  activeRun: boolean;
  busy: boolean;
  start: () => void;
}) {
  const disabled = finding.status !== "open" || busy || activeRun;
  return (
    <button type="button" disabled={disabled} onClick={start}>
      {busy ? "Starting…" : "Start investigation"}
    </button>
  );
}

function SummaryPanel({ summary, findingBase }: { summary: Summary; findingBase: string }) {
  if (summary.state === "loading") return <p>Loading summary…</p>;
  if (summary.state === "missing") return <p>No structured summary for this run.</p>;
  if (summary.state === "error")
    return <p role="alert">Could not load the summary. Reference: {summary.correlationId}</p>;
  return <ResultView data={summary.data} findingBase={findingBase} />;
}

function RunPanel({
  finding,
  runs,
  busy,
  hasMore,
  summary,
  findingBase,
  start,
  loadMore,
  viewSummary,
}: {
  finding: Finding;
  runs: Investigation[];
  busy: boolean;
  hasMore: boolean;
  summary: Summary | null;
  findingBase: string;
  start: () => void;
  loadMore: () => void;
  viewSummary: (run: Investigation) => void;
}) {
  return (
    <section>
      <h2>{finding.vulnerability.sourceId}</h2>
      <p>{finding.purl}</p>
      {finding.vulnerability.summary && <p>{finding.vulnerability.summary}</p>}
      <StartControl finding={finding} activeRun={runs.some(active)} busy={busy} start={start} />
      {finding.status === "resolved" && <p>Resolved findings cannot be investigated.</p>}
      <RunHistory runs={runs} hasMore={hasMore} loadMore={loadMore} viewSummary={viewSummary} />
      {summary && <SummaryPanel summary={summary} findingBase={findingBase} />}
    </section>
  );
}

export function InvestigationWorkspace({
  orgId,
  orgSlug,
  projectSlug,
  initial,
}: {
  orgId: string;
  orgSlug: string;
  projectSlug: string;
  initial: Page<Finding>;
}) {
  const [findings, setFindings] = useState(initial.items);
  const [findingCursor, setFindingCursor] = useState(initial.nextCursor);
  const [selected, setSelected] = useState<Finding | null>(null);
  const [runs, setRuns] = useState<Investigation[]>([]);
  const [runCursor, setRunCursor] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  // The run whose summary the user asked for last; a slower earlier answer must not replace it.
  const wantedRun = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    async (findingId: string, initial = false) => {
      const result = await runsForFinding(orgId, projectSlug, findingId);
      if (result.ok) {
        setRuns((previous) => {
          const ids = new Set(result.data.items.map((r) => r.id));
          return [...result.data.items, ...previous.filter((r) => !ids.has(r.id))];
        });
        if (initial) setRunCursor(result.data.nextCursor);
      } else setError(`Could not load investigations. Reference: ${result.correlationId}`);
    },
    [orgId, projectSlug],
  );

  useEffect(() => {
    if (!selected || !runs.some(active)) return;
    const timer = setInterval(() => void refresh(selected.id), 3000);
    return () => clearInterval(timer);
  }, [selected, runs, refresh]);

  async function choose(finding: Finding) {
    setSelected(finding);
    setRuns([]);
    setRunCursor(null);
    wantedRun.current = null;
    setSummary(null);
    setError(null);
    await refresh(finding.id, true);
  }

  async function viewSummary(run: Investigation) {
    wantedRun.current = run.id;
    setSummary({ runId: run.id, state: "loading" });
    const result = await resultForRun(orgId, projectSlug, run.findingId, run.id);
    if (wantedRun.current !== run.id) return;
    setSummary(
      result.ok
        ? { runId: run.id, state: "ready", data: result.data }
        : result.status === 404
          ? { runId: run.id, state: "missing" }
          : { runId: run.id, state: "error", correlationId: result.correlationId },
    );
  }

  async function start() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const result = await startInvestigation(orgId, projectSlug, selected.id);
      if (!result.ok) {
        setError(
          result.status === 429
            ? "This organization has too many investigations in progress."
            : `Could not start the investigation. Reference: ${result.correlationId}`,
        );
        return;
      }
      await refresh(selected.id);
    } finally {
      setBusy(false);
    }
  }

  async function loadMoreFindings() {
    if (!findingCursor) return;
    const result = await moreFindings(orgId, projectSlug, findingCursor);
    if (result.ok) {
      setFindings((items) => [...items, ...result.data.items]);
      setFindingCursor(result.data.nextCursor);
    } else setError(`Could not load more findings. Reference: ${result.correlationId}`);
  }

  async function loadMoreRuns() {
    if (!selected || !runCursor) return;
    const result = await runsForFinding(orgId, projectSlug, selected.id, runCursor);
    if (result.ok) {
      setRuns((items) => [...items, ...result.data.items]);
      setRunCursor(result.data.nextCursor);
    } else setError(`Could not load more runs. Reference: ${result.correlationId}`);
  }

  return (
    <>
      <FindingPicker
        findings={findings}
        selectedId={selected?.id}
        hasMore={!!findingCursor}
        choose={(finding) => void choose(finding)}
        loadMore={() => void loadMoreFindings()}
      />
      {selected && (
        <RunPanel
          finding={selected}
          runs={runs}
          busy={busy}
          hasMore={!!runCursor}
          summary={summary}
          findingBase={`/orgs/${encodeURIComponent(orgSlug)}/projects/${encodeURIComponent(projectSlug)}/findings`}
          start={() => void start()}
          loadMore={() => void loadMoreRuns()}
          viewSummary={(run) => void viewSummary(run)}
        />
      )}
      {error && <p role="alert">{error}</p>}
    </>
  );
}
