// The four read-only tools. Org, project and finding come from the investigation row (`ToolScope`),
// never from the model's arguments, and every tenant query filters on all three. Priority, KEV and
// advisory-group logic is reused from finding-sql.ts so the tools cannot disagree with the findings UI.
import type { PoolClient } from "pg";
import {
  advisoriesOfGroup,
  findingSql,
  KEV_ENTRY_MATCHES_ADVISORY,
  toPriority,
  type FindingRow,
} from "./finding-sql.ts";
import { isUuid } from "./org-input.ts";
import { Bounds, fitItems, fitOptional } from "./tool-bounds.ts";
import type { ToolName } from "./tool-contracts.ts";

export interface ToolScope {
  orgId: string;
  projectId: string;
  findingId: string;
}

export type ToolOutput =
  { outcome: "ok"; data: object; truncated: boolean } | { outcome: "not_found" | "invalid_args" };

type Db = Pick<PoolClient, "query">;

type ToolHandler = (db: Db, scope: ToolScope, args: Record<string, unknown>) => Promise<ToolOutput>;

const DEFAULT_PAGE = 5;
const MAX_OCCURRENCES = 20;
const MAX_GROUP_MEMBERS = 20;
const MAX_SEVERITIES = 5;
const MAX_SEVERITY_BYTES = 256;

const ok = (data: object, bounds: Bounds): ToolOutput => ({
  outcome: "ok",
  data,
  truncated: bounds.truncated,
});

const num = (value: string | null) => (value === null ? null : Number(value));

const getFindingRisk: ToolHandler = async (db, scope) => {
  const { rows } = await db.query<FindingRow>(
    findingSql({
      baseWhere: "f.org_id = $1 AND f.project_id = $2 AND f.id = $3",
      where: [],
      order: "s.id",
      limit: "1",
    }),
    [scope.orgId, scope.projectId, scope.findingId],
  );
  const row = rows[0];
  if (!row) return { outcome: "not_found" };
  const bounds = new Bounds();
  const data = fitOptional(
    (full) => ({
      finding: {
        id: row.id,
        purl: bounds.required(row.purl, 512),
        version: bounds.required(row.version, 128),
        ecosystem: row.ecosystem,
        scope: row.scope,
        status: row.status,
        resolvedReason: row.resolved_reason,
        matchQuality: row.match_quality,
        matchReason: row.match_reason,
        evidence: full ? bounds.evidence(row.evidence) : null,
        firstSeenAt: row.first_seen_at.toISOString(),
        lastSeenAt: row.last_seen_at.toISOString(),
      },
      priority: toPriority(row),
      kevStatus: row.kev_status,
      advisory: {
        source: row.source,
        sourceId: bounds.required(row.source_id, 256),
        aliases: full ? bounds.aliases(row.aliases) : [],
        summary: bounds.text(row.summary),
        cvssScore: num(row.cvss_score),
        cvssVersion: row.cvss_version,
      },
    }),
    bounds,
  );
  return ok(data, bounds);
};

type Relation = "same_package" | "same_advisory_group";
const encodeCursor = (relation: Relation, id: string) =>
  Buffer.from(JSON.stringify([relation, id])).toString("base64url");

/** The last finding ID of the previous page, or null when the cursor is not one we issued for `relation`. */
function decodeCursor(cursor: string, relation: Relation): string | null {
  try {
    const [rel, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown[];
    return rel === relation && typeof id === "string" && isUuid(id) ? id : null;
  } catch {
    return null;
  }
}

/** The open findings related to the investigated one by `relation`, one page plus one row to detect a next page. */
async function relatedRows(
  db: Db,
  scope: ToolScope,
  relation: Relation,
  after: string | undefined,
  limit: number,
) {
  const own = await db.query<{ purl: string; gid: string }>(
    `SELECT f.purl, COALESCE(m.group_id, f.vulnerability_id) AS gid
     FROM findings f LEFT JOIN vulnerability_group_members m ON m.vulnerability_id = f.vulnerability_id
     WHERE f.id = $1 AND f.org_id = $2 AND f.project_id = $3`,
    [scope.findingId, scope.orgId, scope.projectId],
  );
  if (!own.rows[0]) return undefined;

  // $3 is the investigated dependency, $4 its advisory group; both are always bound.
  const values: unknown[] = [scope.orgId, scope.projectId, own.rows[0].purl, own.rows[0].gid];
  const where = ["s.status = 'open'", "NOT (s.purl = $3 AND s.gid = $4)"];
  if (after) {
    values.push(after);
    where.push(`s.id > $${values.length}::uuid`);
  }
  values.push(limit + 1);
  const { rows } = await db.query<FindingRow>(
    findingSql({
      baseWhere:
        relation === "same_package"
          ? "f.org_id = $1 AND f.project_id = $2 AND f.purl = $3"
          : "f.org_id = $1 AND f.project_id = $2 AND COALESCE(m.group_id, f.vulnerability_id) = $4",
      where,
      order: "s.id",
      limit: `$${values.length}`,
    }),
    values,
  );
  return rows;
}

const toRelatedItem = (row: FindingRow, bounds: Bounds) => ({
  findingId: row.id,
  purl: bounds.required(row.purl, 512),
  version: bounds.required(row.version, 128),
  scope: row.scope,
  matchQuality: row.match_quality,
  advisory: {
    source: row.source,
    sourceId: bounds.required(row.source_id, 256),
    aliases: bounds.aliases(row.aliases),
  },
  priorityTier: toPriority(row).tier,
  kevStatus: row.kev_status,
});

const listRelatedFindings: ToolHandler = async (db, scope, args) => {
  const relation = args["relation"] as Relation;
  const limit = (args["limit"] as number | undefined) ?? DEFAULT_PAGE;
  const cursor = args["cursor"] as string | undefined;
  const after = cursor === undefined ? undefined : decodeCursor(cursor, relation);
  if (after === null) return { outcome: "invalid_args" };
  const rows = await relatedRows(db, scope, relation, after, limit);
  if (!rows) return { outcome: "not_found" };

  const bounds = new Bounds();
  const items = rows.slice(0, limit).map((row) => toRelatedItem(row, bounds));
  // Sized with a real-length cursor so adding it afterwards cannot push the result over the cap.
  const sizing = encodeCursor(relation, scope.findingId);
  const kept = fitItems(items, (k) => ({ items: k, nextCursor: sizing }), bounds);
  const last = kept.at(-1);
  const more = rows.length > limit || kept.length < items.length;
  const nextCursor = more && last ? encodeCursor(relation, last.findingId) : null;
  return ok({ items: kept, nextCursor }, bounds);
};

interface OccurrenceRow {
  purl: string;
  version: string;
  scope: string;
  occurrences: number;
}

const getDependencyOccurrences: ToolHandler = async (db, scope) => {
  const params = [scope.findingId, scope.orgId, scope.projectId];
  const imported = await db.query<{ import_id: string; imported_at: Date }>(
    `SELECT i.id AS import_id, i.created_at AS imported_at
     FROM findings f JOIN sbom_imports i
       ON i.id = f.import_id AND i.org_id = f.org_id AND i.project_id = f.project_id
     WHERE f.id = $1 AND f.org_id = $2 AND f.project_id = $3`,
    params,
  );
  const header = imported.rows[0];
  if (!header) return { outcome: "not_found" };
  // Same ecosystem and match name as the investigated dependency, in the same import.
  const { rows } = await db.query<OccurrenceRow>(
    `SELECT d.purl, d.version, d.scope, d.occurrences
     FROM findings f
     JOIN sbom_dependencies own ON own.import_id = f.import_id AND own.purl = f.purl
       AND own.org_id = f.org_id AND own.project_id = f.project_id
     JOIN sbom_dependencies d ON d.import_id = own.import_id AND d.org_id = own.org_id
       AND d.project_id = own.project_id AND d.ecosystem = own.ecosystem AND d.match_name = own.match_name
     WHERE f.id = $1 AND f.org_id = $2 AND f.project_id = $3
     ORDER BY d.version, d.purl LIMIT ${MAX_OCCURRENCES + 1}`,
    params,
  );
  const bounds = new Bounds();
  bounds.truncated = rows.length > MAX_OCCURRENCES;
  const items = rows.slice(0, MAX_OCCURRENCES).map((r) => ({
    purl: bounds.required(r.purl, 512),
    version: bounds.required(r.version, 128),
    scope: r.scope,
    occurrences: r.occurrences,
  }));
  const build = (kept: typeof items) => ({
    importId: header.import_id,
    importedAt: header.imported_at.toISOString(),
    occurrences: kept,
  });
  return ok(build(fitItems(items, build, bounds)), bounds);
};

interface AdvisoryRow {
  id: string;
  source: string;
  source_id: string;
  aliases: string[];
  summary: string | null;
  severity: unknown;
  cvss_score: string | null;
  cvss_version: string | null;
}

interface KevRow {
  cve_id: string;
  name: string | null;
  vendor_project: string | null;
  product: string | null;
  date_added: string;
  due_date: string | null;
  known_ransomware_use: string | null;
  required_action: string | null;
}

/** Severity entries are source-supplied JSON: keep only string type/vector pairs, capped. */
function toSeverities(value: unknown, bounds: Bounds) {
  const entries = Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
  if (entries.length > MAX_SEVERITIES) bounds.truncated = true;
  return entries
    .slice(0, MAX_SEVERITIES)
    .filter((e) => typeof e?.["type"] === "string" && typeof e["vector"] === "string")
    .map((e) => ({
      type: bounds.required(e["type"] as string, MAX_SEVERITY_BYTES),
      vector: bounds.required(e["vector"] as string, MAX_SEVERITY_BYTES),
    }));
}

/** Other advisories in the same group, and the first KEV entry matching the advisory or any group member. */
async function advisoryContext(db: Db, advisoryId: string) {
  const [members, kev] = await Promise.all([
    db.query<{ source: string; source_id: string }>(
      `SELECT v.source, v.source_id
       FROM vulnerability_group_members own
       JOIN vulnerability_group_members m ON m.group_id = own.group_id
       JOIN vulnerabilities v ON v.id = m.vulnerability_id
       WHERE own.vulnerability_id = $1 AND m.vulnerability_id <> $1
       ORDER BY v.source, v.source_id LIMIT ${MAX_GROUP_MEMBERS + 1}`,
      [advisoryId],
    ),
    db.query<KevRow>(
      `SELECT k.cve_id, k.name, k.vendor_project, k.product, k.date_added::text AS date_added,
              k.due_date::text AS due_date, k.known_ransomware_use, k.required_action
       FROM (SELECT $1::uuid AS vulnerability_id,
                    (SELECT group_id FROM vulnerability_group_members WHERE vulnerability_id = $1) AS group_id) g
       JOIN vulnerabilities a ON ${advisoriesOfGroup("g")}
       JOIN kev_entries k ON ${KEV_ENTRY_MATCHES_ADVISORY}
       ORDER BY k.cve_id LIMIT 1`,
      [advisoryId],
    ),
  ]);
  return { members: members.rows, kev: kev.rows[0] };
}

const toKev = (entry: KevRow, bounds: Bounds) => ({
  cveId: entry.cve_id,
  name: bounds.text(entry.name, 256),
  vendorProject: bounds.text(entry.vendor_project, 256),
  product: bounds.text(entry.product, 256),
  dateAdded: entry.date_added,
  dueDate: entry.due_date,
  knownRansomwareUse: bounds.text(entry.known_ransomware_use, 64),
  requiredAction: bounds.text(entry.required_action),
});

const lookupAdvisory: ToolHandler = async (db, _scope, args) => {
  const id = args["id"] as string;
  const found = await db.query<AdvisoryRow>(
    `SELECT id, source, source_id, aliases, summary, severity, cvss_score, cvss_version
     FROM vulnerabilities WHERE source_id = $1 OR $1 = ANY(aliases)
     ORDER BY (source_id = $1) DESC, source, source_id LIMIT 1`,
    [id],
  );
  const advisory = found.rows[0];
  if (!advisory) return { outcome: "not_found" };
  const context = await advisoryContext(db, advisory.id);

  const bounds = new Bounds();
  bounds.truncated = context.members.length > MAX_GROUP_MEMBERS;
  const groupMembers = context.members.slice(0, MAX_GROUP_MEMBERS).map((m) => ({
    source: m.source,
    sourceId: bounds.required(m.source_id, 256),
  }));
  const base = {
    advisory: {
      source: advisory.source,
      sourceId: bounds.required(advisory.source_id, 256),
      aliases: bounds.aliases(advisory.aliases),
      summary: bounds.text(advisory.summary),
      severity: toSeverities(advisory.severity, bounds),
      cvssScore: num(advisory.cvss_score),
      cvssVersion: advisory.cvss_version,
    },
    kev: context.kev ? toKev(context.kev, bounds) : null,
  };
  const build = (kept: typeof groupMembers) => ({ ...base, groupMembers: kept });
  return ok(build(fitItems(groupMembers, build, bounds)), bounds);
};

export const TOOL_HANDLERS: Record<ToolName, ToolHandler> = {
  get_finding_risk: getFindingRisk,
  list_related_findings: listRelatedFindings,
  get_dependency_occurrences: getDependencyOccurrences,
  lookup_advisory: lookupAdvisory,
};
