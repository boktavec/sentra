// The authority behind the internal tool listener (ADR 0009). Every call re-reads the investigation
// row: scope comes from the row, and the run must still be running under the caller's lease. Whether
// the run's creator is still a member is deliberately not checked (run-scoped authority, Q6).
import type { Pool, PoolClient } from "pg";
import { AppError, type Logger } from "@sentra/ts-platform";
import { TOOL_HANDLERS, type ToolOutput, type ToolScope } from "./investigation-tool-handlers.ts";
import * as metrics from "./metrics.ts";
import { inTransaction } from "./orgs.ts";
import {
  buildResult,
  loadResultContract,
  RESULT_SCHEMA_VERSION,
  type LedgerCall,
  type ResultContract,
  type Snapshot,
  type ViolationCode,
} from "./investigation-result.ts";
import { jsonBytes } from "./tool-bounds.ts";
import type { ToolName, ToolValidators } from "./tool-contracts.ts";
import { signToken, type SigningKey } from "./tool-token.ts";

const MAX_TOOL_CALLS = 8;
export const MAX_ROUNDS = 4;
const STATEMENT_TIMEOUT_MS = 2000;
/** Runs stamped with this prompt version or later end with a stored result instead of a draft. */
const PROMPT_VERSION_WITH_RESULT = 3;

const ERROR_CODES = {
  invalid_args: "invalid_args",
  not_found: "not_found",
  limit: "call_limit_reached",
} as const;

/** `call` is the number the model cites as `call:<n>` (SENTRA-19); only a successful call can be cited. */
type ToolResponse =
  | { outcome: "ok"; call: number; data: object; truncated: boolean }
  | { outcome: keyof typeof ERROR_CODES; error: { code: string } };

const leaseLost = () =>
  new AppError("lease_lost", 409, "Investigation is not running under this lease", {
    reason: "lease_lost",
  });

interface LiveRun extends ToolScope {
  attempt: number;
  /** The earlier of the lease and the attempt deadline. */
  expiresAt: Date;
}

interface LiveRunRow {
  org_id: string;
  project_id: string;
  finding_id: string;
  attempts: number;
  expires_at: Date;
}

type CallOutcome = ToolOutput["outcome"] | "limit";
type Outcome = CallOutcome | "error";

interface LedgerEntry {
  tool: ToolName | "token_exchange";
  round: number;
  /** The validated arguments, or null when invalid or not taken. */
  args: object | null;
  outcome: Outcome;
  result: object | null;
  truncated?: boolean;
  durationMs: number;
}

/** Serializes calls for one run, so the per-attempt call cap is exact even if the caller is concurrent. */
const lockRun = (db: Pick<PoolClient, "query">, investigationId: string) =>
  db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [investigationId]);

async function findLiveRun(
  db: Pick<PoolClient, "query">,
  investigationId: string,
  leaseOwner: string,
): Promise<LiveRun | undefined> {
  const { rows } = await db.query<LiveRunRow>(
    `SELECT org_id, project_id, finding_id, attempts,
            LEAST(lease_expires_at, attempt_deadline_at) AS expires_at
     FROM investigations
     WHERE id = $1 AND status = 'running' AND lease_owner = $2 AND lease_expires_at > now()
       AND (attempt_deadline_at IS NULL OR attempt_deadline_at > now())`,
    [investigationId, leaseOwner],
  );
  const row = rows[0];
  return (
    row && {
      orgId: row.org_id,
      projectId: row.project_id,
      findingId: row.finding_id,
      attempt: row.attempts,
      expiresAt: row.expires_at,
    }
  );
}

/** Appends to the ledger and returns the call number; token exchanges are not numbered. */
async function recordCall(
  db: Pick<PoolClient, "query">,
  investigationId: string,
  run: LiveRun,
  entry: LedgerEntry,
): Promise<number | null> {
  const { rows } = await db.query<{ call_no: number | null }>(
    `INSERT INTO investigation_tool_calls (investigation_id, org_id, project_id, attempt, round, tool,
       args, outcome, result, result_bytes, truncated, duration_ms, call_no)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
       CASE WHEN $6 = 'token_exchange' THEN NULL
         ELSE (SELECT coalesce(max(call_no), 0) + 1 FROM investigation_tool_calls
               WHERE investigation_id = $1 AND attempt = $4) END)
     RETURNING call_no`,
    [
      investigationId,
      run.orgId,
      run.projectId,
      run.attempt,
      entry.round,
      entry.tool,
      entry.args,
      entry.outcome,
      entry.result,
      entry.result === null ? null : jsonBytes(entry.result),
      entry.truncated ?? false,
      entry.durationMs,
    ],
  );
  return rows[0]!.call_no;
}

export interface ToolCall {
  investigationId: string;
  leaseOwner: string;
  tool: ToolName;
  round: number;
  args: Record<string, unknown>;
}

/** Enforces the per-attempt cap and the argument contract, then runs the tool. */
async function runTool(
  db: PoolClient,
  run: LiveRun,
  call: ToolCall,
  validators: ToolValidators,
): Promise<{ outcome: CallOutcome; args: object | null; data?: object; truncated?: boolean }> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM investigation_tool_calls
     WHERE investigation_id = $1 AND attempt = $2 AND tool <> 'token_exchange'`,
    [call.investigationId, run.attempt],
  );
  if (rows[0]!.n >= MAX_TOOL_CALLS) return { outcome: "limit", args: null };
  if (!validators.arguments(call.args)) return { outcome: "invalid_args", args: null };
  const output = await TOOL_HANDLERS[call.tool](db, run, call.args);
  if (output.outcome !== "ok") return { outcome: output.outcome, args: call.args };
  if (!validators.result(output.data)) {
    throw new Error(`${call.tool} result violates its contract`);
  }
  return { ...output, args: call.args };
}

/** Trades the secret plus the current lease owner for a token that lasts until the lease or deadline ends. */
async function exchangeToken(
  pool: Pool,
  signingKeys: SigningKey[],
  investigationId: string,
  leaseOwner: string,
) {
  const started = performance.now();
  return inTransaction(pool, async (db) => {
    await lockRun(db, investigationId);
    const run = await findLiveRun(db, investigationId, leaseOwner);
    if (!run) throw leaseLost();
    const token = signToken(signingKeys, {
      inv: investigationId,
      lease: leaseOwner,
      exp: Math.floor(run.expiresAt.getTime() / 1000),
    });
    await recordCall(db, investigationId, run, {
      tool: "token_exchange",
      round: 0,
      args: null,
      outcome: "ok",
      result: { expiresAt: run.expiresAt.toISOString() },
      durationMs: Math.round(performance.now() - started),
    });
    return { token, expiresAt: run.expiresAt.toISOString() };
  });
}

async function callTool(
  pool: Pool,
  validators: Record<ToolName, ToolValidators>,
  call: ToolCall,
  log: Logger,
): Promise<ToolResponse> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  let run: LiveRun | undefined;
  const record = (outcome: Outcome, entry: Partial<LedgerEntry> = {}) => ({
    tool: call.tool,
    round: call.round,
    args: null,
    outcome,
    result: null,
    durationMs: elapsed(),
    ...entry,
  });
  try {
    const result = await inTransaction(pool, async (db) => {
      await db.query("SELECT set_config('statement_timeout', $1, true)", [
        String(STATEMENT_TIMEOUT_MS),
      ]);
      await lockRun(db, call.investigationId);
      run = await findLiveRun(db, call.investigationId, call.leaseOwner);
      if (!run) throw leaseLost();
      const done = await runTool(db, run, call, validators[call.tool]);
      const callNo = await recordCall(
        db,
        call.investigationId,
        run,
        record(done.outcome, {
          args: done.args,
          result: done.data ?? null,
          truncated: done.truncated ?? false,
        }),
      );
      return { ...done, callNo: callNo! };
    });
    metrics.inc("investigation_tool_calls_total", { tool: call.tool, outcome: result.outcome });
    metrics.observe("investigation_tool_duration_seconds", { tool: call.tool }, elapsed() / 1000);
    log.info(
      {
        investigationId: call.investigationId,
        orgId: run!.orgId,
        tool: call.tool,
        outcome: result.outcome,
        durationMs: elapsed(),
      },
      "investigation_tool_call",
    );
    return toResponse(result);
  } catch (err) {
    if (run && !(err instanceof AppError)) {
      // The transaction rolled back with the failure; keep evidence that the call happened.
      metrics.inc("investigation_tool_calls_total", { tool: call.tool, outcome: "error" });
      await recordCall(pool, call.investigationId, run, record("error")).catch(
        (ledgerErr: unknown) => log.error({ err: String(ledgerErr) }, "tool_ledger_write_failed"),
      );
    }
    throw err;
  }
}

function toResponse(done: Awaited<ReturnType<typeof runTool>> & { callNo: number }): ToolResponse {
  if (done.outcome === "ok") {
    return { outcome: "ok", call: done.callNo, data: done.data!, truncated: done.truncated! };
  }
  return { outcome: done.outcome, error: { code: ERROR_CODES[done.outcome] } };
}

type CompleteOutcome =
  { outcome: "ok" } | { outcome: "invalid_result"; violations: ViolationCode[] };

interface LedgerRow {
  call_no: number;
  attempt: number;
  tool: ToolName;
  outcome: string;
  truncated: boolean;
  result: unknown;
}

/** The whole investigation's numbered calls; result bodies are loaded only for the current attempt. */
async function loadLedger(
  db: Pick<PoolClient, "query">,
  investigationId: string,
  attempt: number,
): Promise<LedgerCall[]> {
  const { rows } = await db.query<LedgerRow>(
    `SELECT call_no, attempt, tool, outcome, truncated, CASE WHEN attempt = $2 THEN result END AS result
     FROM investigation_tool_calls
     WHERE investigation_id = $1 AND call_no IS NOT NULL ORDER BY attempt, call_no`,
    [investigationId, attempt],
  );
  return rows.map((r) => ({
    callNo: r.call_no,
    attempt: r.attempt,
    tool: r.tool,
    outcome: r.outcome,
    truncated: r.truncated,
    result: r.result,
  }));
}

/**
 * Validates the model's answer against the ledger and, if it holds, stores it and completes the run in one
 * transaction. Idempotent: a repeat after success finds the stored result and writes nothing.
 */
async function completeRun(
  pool: Pool,
  contract: ResultContract,
  investigationId: string,
  leaseOwner: string,
  answer: unknown,
): Promise<CompleteOutcome & { orgId: string }> {
  return inTransaction(pool, async (db) => {
    await lockRun(db, investigationId);
    const run = await findLiveRun(db, investigationId, leaseOwner);
    if (!run) {
      const stored = await db.query<{ org_id: string }>(
        "SELECT org_id FROM investigation_results WHERE investigation_id = $1",
        [investigationId],
      );
      if (stored.rows[0]) return { outcome: "ok", orgId: stored.rows[0].org_id };
      throw leaseLost();
    }
    const { rows } = await db.query<{
      context_snapshot: Snapshot;
      model_id: string;
      prompt_version: number;
    }>("SELECT context_snapshot, model_id, prompt_version FROM investigations WHERE id = $1", [
      investigationId,
    ]);
    const row = rows[0]!;
    if (row.prompt_version < PROMPT_VERSION_WITH_RESULT) {
      throw new AppError("invalid_input", 400, "Invalid input", { reason: "prompt_version" });
    }
    const calls = await loadLedger(db, investigationId, run.attempt);
    const built = buildResult(
      contract,
      answer,
      calls,
      {
        findingId: run.findingId,
        snapshot: row.context_snapshot,
        modelId: row.model_id,
        promptVersion: row.prompt_version,
        attempt: run.attempt,
      },
      new Date(),
    );
    if (!built.ok) {
      return { outcome: "invalid_result", violations: built.violations, orgId: run.orgId };
    }
    await db.query(
      `INSERT INTO investigation_results (investigation_id, org_id, project_id, attempt, schema_version, result)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [investigationId, run.orgId, run.projectId, run.attempt, RESULT_SCHEMA_VERSION, built.value],
    );
    await db.query(
      `UPDATE investigations SET status = 'completed', failure_code = NULL, lease_owner = NULL,
         lease_expires_at = NULL, completed_at = now(), updated_at = now()
       WHERE id = $1 AND org_id = $2`,
      [investigationId, run.orgId],
    );
    return { outcome: "ok", orgId: run.orgId };
  });
}

async function complete(
  pool: Pool,
  contract: ResultContract,
  request: { investigationId: string; leaseOwner: string; round: number; result: unknown },
  log: Logger,
): Promise<CompleteOutcome> {
  let done: Awaited<ReturnType<typeof completeRun>>;
  try {
    done = await completeRun(
      pool,
      contract,
      request.investigationId,
      request.leaseOwner,
      request.result,
    );
  } catch (err) {
    if (err instanceof AppError && err.code === "lease_lost") {
      metrics.inc("investigation_result_outcomes_total", { outcome: "lease_lost" });
    }
    throw err;
  }
  metrics.inc("investigation_result_outcomes_total", { outcome: done.outcome });
  const violations = done.outcome === "invalid_result" ? done.violations : [];
  for (const code of violations) metrics.inc("investigation_result_violations_total", { code });
  // Violation codes only: the answer itself is never logged.
  log.info(
    {
      investigationId: request.investigationId,
      orgId: done.orgId,
      round: request.round,
      outcome: done.outcome,
      violations,
    },
    "investigation_result",
  );
  return done.outcome === "ok" ? { outcome: "ok" } : { outcome: "invalid_result", violations };
}

export function createInvestigationTools(
  pool: Pool,
  options: { signingKeys: SigningKey[]; validators: Record<ToolName, ToolValidators> },
) {
  const resultContract = loadResultContract();
  return {
    exchangeToken: (investigationId: string, leaseOwner: string) =>
      exchangeToken(pool, options.signingKeys, investigationId, leaseOwner),
    callTool: (call: ToolCall, log: Logger) => callTool(pool, options.validators, call, log),
    complete: (
      request: { investigationId: string; leaseOwner: string; round: number; result: unknown },
      log: Logger,
    ) => complete(pool, resultContract, request, log),
  };
}

export type InvestigationTools = ReturnType<typeof createInvestigationTools>;
