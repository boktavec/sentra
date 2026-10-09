// The authority behind the internal tool listener (ADR 0009). Every call re-reads the investigation
// row: scope comes from the row, and the run must still be running under the caller's lease. Whether
// the run's creator is still a member is deliberately not checked (run-scoped authority, Q6).
import type { Pool, PoolClient } from "pg";
import { AppError, type Logger } from "@sentra/ts-platform";
import { TOOL_HANDLERS, type ToolOutput, type ToolScope } from "./investigation-tool-handlers.ts";
import * as metrics from "./metrics.ts";
import { inTransaction } from "./orgs.ts";
import { jsonBytes } from "./tool-bounds.ts";
import type { ToolName, ToolValidators } from "./tool-contracts.ts";
import { signToken, type SigningKey } from "./tool-token.ts";

const MAX_TOOL_CALLS = 8;
export const MAX_ROUNDS = 4;
const STATEMENT_TIMEOUT_MS = 2000;

const ERROR_CODES = {
  invalid_args: "invalid_args",
  not_found: "not_found",
  limit: "call_limit_reached",
} as const;

type ToolResponse =
  | { outcome: "ok"; data: object; truncated: boolean }
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

function recordCall(
  db: Pick<PoolClient, "query">,
  investigationId: string,
  run: LiveRun,
  entry: LedgerEntry,
) {
  return db.query(
    `INSERT INTO investigation_tool_calls (investigation_id, org_id, project_id, attempt, round, tool,
       args, outcome, result, result_bytes, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
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
      entry.durationMs,
    ],
  );
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
      await recordCall(
        db,
        call.investigationId,
        run,
        record(done.outcome, { args: done.args, result: done.data ?? null }),
      );
      return done;
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

function toResponse(done: Awaited<ReturnType<typeof runTool>>): ToolResponse {
  if (done.outcome === "ok") return { outcome: "ok", data: done.data!, truncated: done.truncated! };
  return { outcome: done.outcome, error: { code: ERROR_CODES[done.outcome] } };
}

export function createInvestigationTools(
  pool: Pool,
  options: { signingKeys: SigningKey[]; validators: Record<ToolName, ToolValidators> },
) {
  return {
    exchangeToken: (investigationId: string, leaseOwner: string) =>
      exchangeToken(pool, options.signingKeys, investigationId, leaseOwner),
    callTool: (call: ToolCall, log: Logger) => callTool(pool, options.validators, call, log),
  };
}

export type InvestigationTools = ReturnType<typeof createInvestigationTools>;
