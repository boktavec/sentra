// Turns the model's answer into a stored result (ADR 0010). The model writes only the explanation and its
// citations. Everything the story calls retrieved fact or known gap is derived here from the tool-call
// ledger, so a model cannot supply or contradict it. Pure functions: the caller loads the ledger.
import { readFileSync } from "node:fs";
import { Ajv, type ValidateFunction } from "ajv";
import { jsonBytes } from "./tool-bounds.ts";
import type { ToolName } from "./tool-contracts.ts";

export const RESULT_SCHEMA_VERSION = 1;
// The table caps the result at 32 KiB of jsonb text, which spaces out keys and commas; stay clearly under it.
const MAX_STORED_RESULT_BYTES = 28 * 1024;
const MAX_EVIDENCE_TARGETS = 10;

export type ViolationCode =
  | "schema_invalid"
  | "unknown_evidence_ref"
  | "cross_attempt_ref"
  | "evidence_not_ok"
  | "uncited_claim"
  | "forbidden_field"
  | "missing_uncertainty_reason";

const GAP_CODES = [
  "advisory_not_found",
  "result_truncated",
  "no_cvss",
  "weak_match",
  "finding_resolved",
  "no_tool_evidence",
  "related_findings_not_checked",
  "occurrences_not_checked",
] as const;
export type GapCode = (typeof GAP_CODES)[number];

interface ModelResult {
  summary: string;
  tenantImpact: string;
  nextSteps: string[];
  claims: { text: string; evidence: string[] }[];
  uncertainties: string[];
  noUncertaintyReason?: string;
}

/** One row of the tool-call ledger, as the API itself recorded it. */
export interface LedgerCall {
  callNo: number;
  attempt: number;
  tool: ToolName;
  outcome: string;
  truncated: boolean;
  /** The tool's result body; null for a call that did not succeed. */
  result: unknown;
}

/** The snapshot captured when the investigation was created; used only when get_finding_risk was not called. */
export interface Snapshot {
  finding: {
    purl: string;
    version: string;
    ecosystem: string;
    scope: string;
    matchQuality: string;
  };
  advisory: { source: string; sourceId: string; aliases: string[]; summary: string | null };
}

export interface RunFacts {
  findingId: string;
  snapshot: Snapshot;
  modelId: string;
  promptVersion: number;
  attempt: number;
}

export interface ResultContract {
  validate: ValidateFunction;
  apiWrittenFields: ReadonlySet<string>;
}

export function loadResultContract(
  dir = new URL("../../../packages/contracts/ai-tools/", import.meta.url),
): ResultContract {
  const contract = JSON.parse(
    readFileSync(new URL("investigation-result.v1.json", dir), "utf8"),
  ) as { model: object; apiWrittenFields: string[] };
  return {
    validate: new Ajv({ strict: true }).compile(contract.model),
    apiWrittenFields: new Set(contract.apiWrittenFields),
  };
}

type Outcome<T> = { ok: true; value: T } | { ok: false; violations: ViolationCode[] };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const callNumber = (ref: string) => Number(ref.slice("call:".length));

/**
 * Checks the model's answer against the schema and its citations against the ledger of this attempt.
 * `calls` holds every numbered call of the investigation, across attempts: a number that exists only in an
 * earlier attempt is a different failure from one that exists nowhere.
 */
function validateModelResult(
  contract: ResultContract,
  input: unknown,
  calls: LedgerCall[],
  attempt: number,
): Outcome<ModelResult> {
  const forbidden =
    isObject(input) && Object.keys(input).some((k) => contract.apiWrittenFields.has(k));
  if (forbidden) return { ok: false, violations: ["forbidden_field"] };
  if (!contract.validate(input)) return { ok: false, violations: ["schema_invalid"] };
  const model = input as ModelResult;

  const violations = new Set<ViolationCode>();
  if (model.uncertainties.length === 0 && model.noUncertaintyReason === undefined) {
    violations.add("missing_uncertainty_reason");
  }
  for (const code of citationViolations(model.claims, calls, attempt)) violations.add(code);
  return violations.size > 0
    ? { ok: false, violations: [...violations] }
    : { ok: true, value: model };
}

/** Why `ref` cannot be cited, if it cannot: it must be a successful call of this attempt. */
function refViolation(
  ref: string,
  current: Map<number, LedgerCall>,
  earlier: Set<number>,
): ViolationCode | undefined {
  const number = callNumber(ref);
  const call = current.get(number);
  if (!call) return earlier.has(number) ? "cross_attempt_ref" : "unknown_evidence_ref";
  return call.outcome === "ok" ? undefined : "evidence_not_ok";
}

function citationViolations(
  claims: ModelResult["claims"],
  calls: LedgerCall[],
  attempt: number,
): ViolationCode[] {
  const current = new Map(calls.filter((c) => c.attempt === attempt).map((c) => [c.callNo, c]));
  const earlier = new Set(calls.filter((c) => c.attempt !== attempt).map((c) => c.callNo));
  return claims.flatMap((claim) => [
    ...(claim.evidence.length === 0 ? (["uncited_claim"] as const) : []),
    ...claim.evidence.flatMap((ref) => refViolation(ref, current, earlier) ?? []),
  ]);
}

// The shapes below are the parts of the tool result contracts that this module reads. The API validated
// each result against its contract before recording it.
interface RiskResult {
  finding: {
    id: string;
    purl: string;
    version: string;
    ecosystem: string;
    scope: string;
    status: string;
    matchQuality: string;
  };
  priority: { tier: string; baseReason: string; scopeAdjusted: boolean; factors: unknown };
  kevStatus: string;
  advisory: {
    source: string;
    sourceId: string;
    aliases: string[];
    summary: string | null;
    cvssScore: number | null;
    cvssVersion: string | null;
  };
}
interface RelatedResult {
  items: { findingId: string; purl: string; version: string }[];
}
interface OccurrencesResult {
  occurrences: { purl: string; version: string }[];
}
interface AdvisoryResult {
  advisory: { sourceId: string };
}

type Target = { findingId?: string; purl: string; version: string };
type EvidenceEntry = {
  ref: string;
  tool: ToolName;
  kind: "finding" | "related_finding" | "dependency_occurrence" | "advisory";
  advisoryId?: string;
  targets?: Target[];
};

const okCalls = (calls: LedgerCall[], tool: ToolName) =>
  calls.filter((c) => c.tool === tool && c.outcome === "ok");

function resolveEvidence(call: LedgerCall): EvidenceEntry {
  const base = { ref: `call:${call.callNo}`, tool: call.tool };
  const cap = <T>(items: T[]) => items.slice(0, MAX_EVIDENCE_TARGETS);
  switch (call.tool) {
    case "get_finding_risk": {
      const { finding } = call.result as RiskResult;
      const target = { findingId: finding.id, purl: finding.purl, version: finding.version };
      return { ...base, kind: "finding", targets: [target] };
    }
    case "list_related_findings":
      return {
        ...base,
        kind: "related_finding",
        targets: cap((call.result as RelatedResult).items).map(({ findingId, purl, version }) => ({
          findingId,
          purl,
          version,
        })),
      };
    case "get_dependency_occurrences":
      return {
        ...base,
        kind: "dependency_occurrence",
        targets: cap((call.result as OccurrencesResult).occurrences).map(({ purl, version }) => ({
          purl,
          version,
        })),
      };
    case "lookup_advisory":
      return {
        ...base,
        kind: "advisory",
        advisoryId: (call.result as AdvisoryResult).advisory.sourceId,
      };
  }
}

/** Retrieved facts: from this attempt's get_finding_risk result, else from the creation-time snapshot. */
function assembleFacts(calls: LedgerCall[], run: RunFacts) {
  const risk = okCalls(calls, "get_finding_risk")[0]?.result as RiskResult | undefined;
  if (risk) {
    const { finding, advisory } = risk;
    return {
      source: "get_finding_risk",
      findingId: finding.id,
      purl: finding.purl,
      version: finding.version,
      ecosystem: finding.ecosystem,
      scope: finding.scope,
      status: finding.status,
      matchQuality: finding.matchQuality,
      advisory,
      kevStatus: risk.kevStatus,
      priority: risk.priority,
    };
  }
  const { finding, advisory } = run.snapshot;
  return {
    source: "snapshot",
    findingId: run.findingId,
    purl: finding.purl,
    version: finding.version,
    ecosystem: finding.ecosystem,
    scope: finding.scope,
    status: null,
    matchQuality: finding.matchQuality,
    advisory: {
      source: advisory.source,
      sourceId: advisory.sourceId,
      aliases: advisory.aliases,
      summary: advisory.summary,
      cvssScore: null,
      cvssVersion: null,
    },
    kevStatus: null,
    priority: null,
  };
}

type Facts = ReturnType<typeof assembleFacts>;

export function deriveGaps(calls: LedgerCall[], facts: Facts): GapCode[] {
  const called = (tool: ToolName) => calls.some((c) => c.tool === tool);
  const present: Record<GapCode, boolean> = {
    advisory_not_found: calls.some(
      (c) => c.tool === "lookup_advisory" && c.outcome === "not_found",
    ),
    result_truncated: calls.some((c) => c.truncated),
    no_cvss: facts.advisory.cvssScore === null,
    weak_match: facts.matchQuality !== "confirmed",
    finding_resolved: facts.status === "resolved",
    no_tool_evidence: !calls.some((c) => c.outcome === "ok"),
    related_findings_not_checked: !called("list_related_findings"),
    occurrences_not_checked: !called("get_dependency_occurrences"),
  };
  return GAP_CODES.filter((code) => present[code]);
}

/** Validates the model's answer and, when it holds, returns the result to store. `calls` is the whole investigation. */
export function buildResult(
  contract: ResultContract,
  input: unknown,
  calls: LedgerCall[],
  run: RunFacts,
  now: Date,
): Outcome<object> {
  const checked = validateModelResult(contract, input, calls, run.attempt);
  if (!checked.ok) return checked;
  const model = checked.value;
  const attempt = calls.filter((c) => c.attempt === run.attempt);
  const facts = assembleFacts(attempt, run);
  const cited = new Set(model.claims.flatMap((c) => c.evidence.map(callNumber)));
  const result = {
    ...model,
    claims: model.claims.map((c) => ({ ...c, evidence: [...new Set(c.evidence)] })),
    facts,
    evidence: attempt.filter((c) => cited.has(c.callNo)).map(resolveEvidence),
    gaps: deriveGaps(attempt, facts),
    modelId: run.modelId,
    promptVersion: run.promptVersion,
    generatedAt: now.toISOString(),
  };
  // Only reachable with pathological multi-byte text; the repair turn lets the model shorten it.
  if (jsonBytes(result) > MAX_STORED_RESULT_BYTES)
    return { ok: false, violations: ["schema_invalid"] };
  return { ok: true, value: result };
}
