// Real Postgres, real app routes. Identity is the only thing faked (see orgs.integration.test.ts).
// Findings are written by the correlator, so they are seeded with SQL. Needs `task stack:up`.
// Run with `task api:test:integration`.
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger, unauthenticated } from "@sentra/ts-platform";
import { buildApp } from "./app.ts";
import { createFindingStore } from "./findings.ts";
import { createInvitationStore } from "./invitations.ts";
import { createMemberStore } from "./members.ts";
import { migrate } from "./migrate.ts";
import { createOrgStore } from "./orgs.ts";
import { createProjectStore } from "./projects.ts";
import { createUserStore } from "./users.ts";

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) throw new Error("DATABASE_URL is required (see `task api:test:integration`)");

const logger = createLogger("api-test", {
  level: "debug",
  destination: new Writable({ write: (_chunk, _enc, done) => done() }),
});

let pool: Pool;
let app: ReturnType<typeof buildApp>;
const run = randomUUID().slice(0, 8);

async function newUser() {
  const user = await createUserStore(pool).resolve({
    issuer: "http://findings.test",
    subject: randomUUID(),
  });
  return { id: user.id, headers: { "x-test-user": user.id } };
}

/** An org with one admin and a plain member, and a project in it. */
async function newProject(slug = "web-app") {
  const admin = await newUser();
  const member = await newUser();
  const created = await app.inject({
    method: "POST",
    url: "/v1/orgs",
    headers: admin.headers,
    payload: { name: "Team", slug: `team-${run}-${randomUUID().slice(0, 8)}` },
  });
  const org: { id: string } = created.json();
  await pool.query("INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'member')", [
    org.id,
    member.id,
  ]);
  const project = await app.inject({
    method: "POST",
    url: `/v1/orgs/${org.id}/projects`,
    headers: admin.headers,
    payload: { name: slug, slug },
  });
  expect(project.statusCode, project.body).toBe(201);
  return { org, admin, member, slug, projectId: project.json().id as string };
}

async function importFor(orgId: string, projectId: string, userId: string) {
  const { rows } = await pool.query(
    `INSERT INTO sbom_imports (org_id, project_id, created_by, filename, status, object_key, expires_at)
     VALUES ($1, $2, $3, 'bom.json', 'parsed', $4, now()) RETURNING id`,
    [orgId, projectId, userId, `k-${randomUUID()}`],
  );
  return rows[0].id as string;
}

async function advisory(sourceId: string, source = "osv", summary = "A bug") {
  const { rows } = await pool.query(
    `INSERT INTO vulnerabilities (source, source_id, aliases, summary, severity, modified_at,
       source_artifact_sha256, source_entry, schema_version, adapter_version)
     VALUES ($3, $1, ARRAY['CVE-2026-0001'], $4, '[{"type":"CVSS_V3","vector":"CVSS:3.1/AV:N"}]',
       now(), $2, 'e', 1, 1) RETURNING id`,
    [`${sourceId}-${run}-${randomUUID().slice(0, 6)}`, "a".repeat(64), source, summary],
  );
  return rows[0].id as string;
}

/** What the grouper writes (services/pipeline): one group, its canonical advisory and its members. */
async function group(canonical: string, ...others: string[]) {
  const id = randomUUID();
  await pool.query(
    "INSERT INTO vulnerability_groups (id, canonical_vulnerability_id) VALUES ($1, $2)",
    [id, canonical],
  );
  for (const v of [canonical, ...others]) {
    await pool.query(
      "INSERT INTO vulnerability_group_members (vulnerability_id, group_id) VALUES ($1, $2)",
      [v, id],
    );
  }
  return id;
}

interface Seed {
  orgId: string;
  projectId: string;
  importId: string;
  purl: string;
  firstSeen?: string;
  status?: "open" | "resolved";
  quality?: "confirmed" | "unverifiable";
  vulnerabilityId?: string;
}

async function finding(s: Seed) {
  const resolved = s.status === "resolved";
  const quality = s.quality ?? "confirmed";
  const { rows } = await pool.query(
    `INSERT INTO findings (org_id, project_id, vulnerability_id, purl, version, ecosystem, scope, import_id,
       match_quality, match_reason, status, resolved_reason, resolved_at, first_seen_at, matcher_version, evidence)
     VALUES ($1, $2, $3, $4, '1.0.0', 'PyPI', 'required', $5, $6, $7, $8, $9, $10, $11, 1, $12) RETURNING id`,
    [
      s.orgId,
      s.projectId,
      s.vulnerabilityId ?? (await advisory("PYSEC")),
      s.purl,
      s.importId,
      quality,
      quality === "unverifiable" ? "version_unparseable" : null,
      s.status ?? "open",
      resolved ? "dependency_removed" : null,
      resolved ? new Date() : null,
      s.firstSeen ?? new Date().toISOString(),
      JSON.stringify({ rule: "range", comparator: "pep440", package: "trac" }),
    ],
  );
  return rows[0].id as string;
}

const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: "GET", url, headers });
const listUrl = (orgId: string, slug: string, query = "") =>
  `/v1/orgs/${orgId}/projects/${slug}/findings${query}`;

beforeAll(async () => {
  pool = new Pool({ connectionString: databaseUrl, max: 10 });
  await migrate(pool);
  const userStore = createUserStore(pool);
  app = buildApp({
    logger,
    orgs: createOrgStore(pool, { maxOrgsPerUser: 100 }),
    members: createMemberStore(pool),
    projects: createProjectStore(pool),
    findings: createFindingStore(pool),
    invitations: createInvitationStore(pool, {
      fetchProfile: async () => ({ emailVerified: false }),
      webUrl: "http://localhost:3000",
      limits: { ttlHours: 1, maxPending: 1, maxPerDay: 1, maxMembers: 1 },
    }),
    trustedProxies: false,
    ready: async () => true,
    authenticate: async (request) => {
      const id = request.headers["x-test-user" as "authorization"];
      if (!id) throw unauthenticated("missing_token");
      const { rows } = await pool.query("SELECT issuer, subject FROM users WHERE id = $1", [id]);
      return userStore.resolve(rows[0]);
    },
  });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("listing findings", () => {
  it("returns the finding, its evidence and a summary of the advisory to any member", async () => {
    const { org, admin, member, slug, projectId } = await newProject();
    const importId = await importFor(org.id, projectId, admin.id);
    const id = await finding({ orgId: org.id, projectId, importId, purl: "pkg:pypi/trac@1.0.0" });

    for (const user of [admin, member]) {
      const res = await get(listUrl(org.id, slug), user.headers);
      expect(res.statusCode).toBe(200);
      const { items, nextCursor } = res.json();
      expect(nextCursor).toBeNull();
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        id,
        purl: "pkg:pypi/trac@1.0.0",
        version: "1.0.0",
        ecosystem: "PyPI",
        scope: "required",
        status: "open",
        resolvedReason: null,
        matchQuality: "confirmed",
        matchReason: null,
        importId,
        evidence: { rule: "range", comparator: "pep440", package: "trac" },
        vulnerability: {
          aliases: ["CVE-2026-0001"],
          summary: "A bug",
          severity: [{ type: "CVSS_V3", vector: "CVSS:3.1/AV:N" }],
          source: "osv",
        },
      });
      // Internal bookkeeping is not part of the contract.
      expect(items[0]).not.toHaveProperty("matcherVersion");
      expect(items[0]).not.toHaveProperty("orgId");
    }
  });

  it("shows resolved and unverifiable findings with their reasons", async () => {
    const { org, admin, slug, projectId } = await newProject();
    const importId = await importFor(org.id, projectId, admin.id);
    await finding({ orgId: org.id, projectId, importId, purl: "pkg:pypi/a@1", status: "resolved" });
    await finding({
      orgId: org.id,
      projectId,
      importId,
      purl: "pkg:pypi/b@latest",
      quality: "unverifiable",
    });

    const { items } = (await get(listUrl(org.id, slug, "?status=all"), admin.headers)).json();

    const byPurl = Object.fromEntries(items.map((i: { purl: string }) => [i.purl, i]));
    expect(byPurl["pkg:pypi/a@1"]).toMatchObject({
      status: "resolved",
      resolvedReason: "dependency_removed",
    });
    expect(byPurl["pkg:pypi/b@latest"]).toMatchObject({
      matchQuality: "unverifiable",
      matchReason: "version_unparseable",
    });
  });

  it("pages newest first without skipping or repeating, including findings first seen at the same instant", async () => {
    const { org, admin, slug, projectId } = await newProject();
    const importId = await importFor(org.id, projectId, admin.id);
    const same = "2026-01-02T03:04:05.123456Z";
    const ids = [
      await finding({ orgId: org.id, projectId, importId, purl: "pkg:pypi/a@1", firstSeen: same }),
      await finding({ orgId: org.id, projectId, importId, purl: "pkg:pypi/b@1", firstSeen: same }),
      await finding({ orgId: org.id, projectId, importId, purl: "pkg:pypi/c@1", firstSeen: same }),
      await finding({
        orgId: org.id,
        projectId,
        importId,
        purl: "pkg:pypi/old@1",
        firstSeen: "2025-12-31T00:00:00Z",
      }),
      await finding({
        orgId: org.id,
        projectId,
        importId,
        purl: "pkg:pypi/new@1",
        firstSeen: "2026-02-01T00:00:00Z",
      }),
    ];

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = listUrl(
        org.id,
        slug,
        `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      const body = (await get(url, admin.headers)).json();
      seen.push(...body.items.map((i: { id: string }) => i.id));
      cursor = body.nextCursor;
      pages++;
    } while (cursor);

    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(5);
    expect(new Set(seen)).toEqual(new Set(ids));
    expect(seen[0]).toBe(ids[4]); // newest
    expect(seen[4]).toBe(ids[3]); // oldest
  });

  it("returns an empty page for a project without findings", async () => {
    const { org, admin, slug } = await newProject();
    const res = await get(listUrl(org.id, slug), admin.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [], nextCursor: null });
  });

  it("never mixes in another project's findings, even in the same org", async () => {
    const { org, admin, slug, projectId } = await newProject();
    const other = await app.inject({
      method: "POST",
      url: `/v1/orgs/${org.id}/projects`,
      headers: admin.headers,
      payload: { name: "Other", slug: "other-app" },
    });
    const otherId = other.json().id as string;
    await finding({
      orgId: org.id,
      projectId: otherId,
      importId: await importFor(org.id, otherId, admin.id),
      purl: "pkg:pypi/elsewhere@1",
    });
    await finding({
      orgId: org.id,
      projectId,
      importId: await importFor(org.id, projectId, admin.id),
      purl: "pkg:pypi/here@1",
    });

    const { items } = (await get(listUrl(org.id, slug), admin.headers)).json();

    expect(items.map((i: { purl: string }) => i.purl)).toEqual(["pkg:pypi/here@1"]);
  });

  it("rejects bad input and unknown projects the same way as other list routes", async () => {
    const { org, admin, slug } = await newProject();
    expect((await get(listUrl(org.id, slug, "?limit=0"), admin.headers)).statusCode).toBe(400);
    expect((await get(listUrl(org.id, slug, "?limit=abc"), admin.headers)).statusCode).toBe(400);
    expect((await get(listUrl(org.id, slug, "?cursor=garbage"), admin.headers)).statusCode).toBe(
      400,
    );
    for (const query of ["?status=closed", "?severity=urgent", "?sort=random"]) {
      expect((await get(listUrl(org.id, slug, query), admin.headers)).statusCode).toBe(400);
    }
    const missing = await get(listUrl(org.id, "no-such-project"), admin.headers);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().reason).toBeUndefined(); // the reason is logged, never sent
  });

  it("requires a signed-in user", async () => {
    const { org, slug } = await newProject();
    expect((await get(listUrl(org.id, slug))).statusCode).toBe(401);
  });

  it("sorts grouped issues by the strongest advisory CVSS score and filters the grouped result", async () => {
    const { org, admin, slug, projectId } = await newProject();
    const importId = await importFor(org.id, projectId, admin.id);
    const canonical = await advisory("CANONICAL");
    const severe = await advisory("SEVERE");
    await group(canonical, severe);
    await pool.query(
      "UPDATE vulnerabilities SET cvss_score = 9.8, cvss_version = '3.1', cvss_calculated_at = now() WHERE id = $1",
      [severe],
    );
    await finding({
      orgId: org.id,
      projectId,
      importId,
      purl: "pkg:pypi/grouped@1",
      vulnerabilityId: canonical,
    });
    await finding({
      orgId: org.id,
      projectId,
      importId,
      purl: "pkg:pypi/grouped@1",
      vulnerabilityId: severe,
    });
    const low = await advisory("LOW");
    await pool.query(
      "UPDATE vulnerabilities SET cvss_score = 3.1, cvss_version = '3.1', cvss_calculated_at = now() WHERE id = $1",
      [low],
    );
    await finding({
      orgId: org.id,
      projectId,
      importId,
      purl: "pkg:pypi/low@1",
      vulnerabilityId: low,
    });
    await finding({
      orgId: org.id,
      projectId,
      importId,
      purl: "pkg:pypi/resolved@1",
      status: "resolved",
    });

    const first = (await get(listUrl(org.id, slug, "?limit=1"), admin.headers)).json();
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({
      purl: "pkg:pypi/grouped@1",
      vulnerability: {
        cvssScore: 9.8,
        severityCategory: "critical",
        cvssSource: { source: "osv", sourceId: expect.stringContaining("SEVERE") },
      },
    });
    const next = (
      await get(
        listUrl(org.id, slug, `?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`),
        admin.headers,
      )
    ).json();
    expect(next.items.map((item: { purl: string }) => item.purl)).toEqual(["pkg:pypi/low@1"]);
    expect(next.nextCursor).toBeNull();
    const critical = (await get(listUrl(org.id, slug, "?severity=critical"), admin.headers)).json();
    expect(critical.items.map((item: { purl: string }) => item.purl)).toEqual([
      "pkg:pypi/grouped@1",
    ]);
    const resolved = (await get(listUrl(org.id, slug, "?status=resolved"), admin.headers)).json();
    expect(resolved.items.map((item: { purl: string }) => item.purl)).toEqual([
      "pkg:pypi/resolved@1",
    ]);
    expect(
      (
        await get(
          listUrl(
            org.id,
            slug,
            `?limit=1&severity=critical&cursor=${encodeURIComponent(first.nextCursor)}`,
          ),
          admin.headers,
        )
      ).statusCode,
    ).toBe(400);
  });

  it("uses active KEV enrichment across a group, not a historical advisory stub", async () => {
    const { org, admin, slug, projectId } = await newProject();
    const importId = await importFor(org.id, projectId, admin.id);
    const canonical = await advisory("KEV-CANONICAL");
    const linked = await advisory("KEV-LINKED");
    await group(canonical, linked);
    const cve = `CVE-2026-${parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16)}`;
    await pool.query("UPDATE vulnerabilities SET aliases = ARRAY[$1] WHERE id = $2", [cve, linked]);
    await finding({
      orgId: org.id,
      projectId,
      importId,
      purl: "pkg:pypi/kev@1",
      vulnerabilityId: canonical,
    });
    await pool.query(
      `INSERT INTO normalization_runs (artifact_sha256, source, ecosystem, adapter_version, status, correlation_id)
       VALUES ($1, 'cisa-kev', 'none', 1, 'published', $2)`,
      [randomUUID().replaceAll("-", "").padEnd(64, "a"), `test-${run}`],
    );
    await pool.query(
      `INSERT INTO kev_entries (cve_id, date_added, content_hash, catalog_version, date_released,
         source_artifact_sha256, adapter_version)
       VALUES ($1, CURRENT_DATE, $2, 'test', now(), $2, 1)`,
      [cve, "b".repeat(64)],
    );
    const url = listUrl(org.id, slug);
    expect((await get(url, admin.headers)).json().items[0].kevStatus).toBe("listed");
    await pool.query("UPDATE kev_entries SET removed_at = now() WHERE cve_id = $1", [cve]);
    expect((await get(url, admin.headers)).json().items[0].kevStatus).toBe("not_listed");
  });
});

describe("consolidating advisories of one issue (SENTRA-12)", () => {
  it("shows one item per issue, led by the open finding, with every source advisory listed", async () => {
    const { org, admin, slug, projectId } = await newProject();
    const importId = await importFor(org.id, projectId, admin.id);
    const ghsa = await advisory("GHSA", "osv", "Canonical summary");
    const pysec = await advisory("PYSEC", "osv", "Other summary");
    const kev = await advisory("CVE-2026-0001", "cisa-kev", "Stub summary"); // no finding: no affected rows
    const groupId = await group(ghsa, pysec, kev);
    const purl = "pkg:pypi/trac@1.0.0";
    const resolved = await finding({
      orgId: org.id,
      projectId,
      importId,
      purl,
      vulnerabilityId: ghsa,
      status: "resolved",
      firstSeen: "2026-01-01T00:00:00Z",
    });
    const open = await finding({
      orgId: org.id,
      projectId,
      importId,
      purl,
      vulnerabilityId: pysec,
      firstSeen: "2026-03-01T00:00:00Z",
    });

    const { items } = (await get(listUrl(org.id, slug), admin.headers)).json();

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: open,
      status: "open",
      firstSeenAt: "2026-01-01T00:00:00.000Z", // spans the whole issue
      vulnerability: { id: ghsa, groupId, summary: "Canonical summary" },
    });
    expect(items[0].sources.map((x: { id: string }) => x.id).sort()).toEqual(
      [ghsa, pysec, kev].sort(),
    );
    expect(items[0].sources[0]).toHaveProperty("sourceId");
    expect(items[0].sources[0]).toHaveProperty("aliases");
    expect(resolved).not.toBe(open);
  });

  it("keeps a dependency that is hit by two different issues as two items, and two dependencies as two items", async () => {
    const { org, admin, slug, projectId } = await newProject();
    const importId = await importFor(org.id, projectId, admin.id);
    const a = await advisory("GHSA");
    const b = await advisory("GHSA");
    const g = await group(a);
    await group(b);
    for (const purl of ["pkg:pypi/x@1", "pkg:pypi/y@1"]) {
      await finding({ orgId: org.id, projectId, importId, purl, vulnerabilityId: a });
    }
    await finding({ orgId: org.id, projectId, importId, purl: "pkg:pypi/x@1", vulnerabilityId: b });

    const { items } = (await get(listUrl(org.id, slug), admin.headers)).json();

    expect(items).toHaveLength(3);
    expect(
      items.filter((i: { vulnerability: { groupId: string } }) => i.vulnerability.groupId === g),
    ).toHaveLength(2);
  });

  it("still shows a finding whose advisory the grouper has not reached yet", async () => {
    const { org, admin, slug, projectId } = await newProject();
    const importId = await importFor(org.id, projectId, admin.id);
    const id = await finding({ orgId: org.id, projectId, importId, purl: "pkg:pypi/lag@1" });

    const { items } = (await get(listUrl(org.id, slug), admin.headers)).json();

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id, vulnerability: { groupId: null } });
    expect(items[0].sources).toHaveLength(1);
  });

  it("does not leak another tenant's findings through a shared group", async () => {
    const mine = await newProject();
    const theirs = await newProject();
    const a = await advisory("GHSA");
    const b = await advisory("PYSEC");
    await group(a, b);
    await finding({
      orgId: mine.org.id,
      projectId: mine.projectId,
      importId: await importFor(mine.org.id, mine.projectId, mine.admin.id),
      purl: "pkg:pypi/shared@1",
      vulnerabilityId: a,
    });
    const theirId = await finding({
      orgId: theirs.org.id,
      projectId: theirs.projectId,
      importId: await importFor(theirs.org.id, theirs.projectId, theirs.admin.id),
      purl: "pkg:pypi/shared@1",
      vulnerabilityId: b,
    });

    const { items } = (await get(listUrl(mine.org.id, mine.slug), mine.admin.headers)).json();

    expect(items).toHaveLength(1);
    expect(items.map((i: { id: string }) => i.id)).not.toContain(theirId);
    expect(JSON.stringify(items)).not.toContain(theirs.org.id);
  });
});

describe("finding detail (SENTRA-16)", () => {
  const detailUrl = (orgId: string, slug: string, findingId: string) =>
    `${listUrl(orgId, slug)}/${findingId}`;

  /** The dependency row the correlator joined on, and an affected entry (with one range) for a package. */
  async function dependency(
    s: { orgId: string; projectId: string; importId: string },
    purl: string,
  ) {
    await pool.query(
      `INSERT INTO sbom_dependencies (import_id, org_id, project_id, purl, purl_type, name, version, ecosystem, scope, occurrences)
       VALUES ($1, $2, $3, $4, 'pypi', 'Trac', '1.0.0', 'PyPI', 'required', 1)`,
      [s.importId, s.orgId, s.projectId, purl],
    );
  }
  async function affected(
    vulnerabilityId: string,
    packageName: string,
    events: [string, string][],
    versions: string[] = [],
  ) {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO vulnerability_affected (id, vulnerability_id, ecosystem, package_name, versions)
       VALUES ($1, $2, 'PyPI', $3, $4)`,
      [id, vulnerabilityId, packageName, versions],
    );
    for (const [i, [type, version]] of events.entries()) {
      await pool.query(
        `INSERT INTO vulnerability_ranges (affected_id, range_index, event_index, range_type, event_type, event_version)
         VALUES ($1, 0, $2, 'ECOSYSTEM', $3, $4)`,
        [id, i, type, version],
      );
    }
  }

  async function seedGroup() {
    const project = await newProject();
    const importId = await importFor(project.org.id, project.projectId, project.admin.id);
    const base = { orgId: project.org.id, projectId: project.projectId, importId };
    const ghsa = await advisory("GHSA", "ghsa", "GitHub summary");
    const pysec = await advisory("PYSEC", "osv", "OSV summary");
    await pool.query(
      "UPDATE vulnerabilities SET cvss_score = 9.8, cvss_version = '3.1' WHERE id = $1",
      [pysec],
    );
    await group(ghsa, pysec);
    const purl = "pkg:pypi/trac@1.0.0";
    await dependency(base, purl);
    const ghsaFinding = await finding({ ...base, purl, vulnerabilityId: ghsa });
    const pysecFinding = await finding({
      ...base,
      purl,
      vulnerabilityId: pysec,
      firstSeen: "2030-01-01T00:00:00Z",
    });
    return { ...project, ...base, purl, ghsa, pysec, ghsaFinding, pysecFinding };
  }

  it("shows the same grouped view for any member id, with the requested id echoed", async () => {
    const s = await seedGroup();
    await affected(s.ghsa, "Trac", [
      ["introduced", "0"],
      ["fixed", "1.2.0"],
    ]);
    await affected(s.ghsa, "other-package", [["introduced", "0"]]);

    const [viaLead, viaOther] = await Promise.all(
      [s.ghsaFinding, s.pysecFinding].map((id) =>
        get(detailUrl(s.org.id, s.slug, id), s.member.headers),
      ),
    );

    expect(viaLead!.statusCode, viaLead!.body).toBe(200);
    expect(viaLead!.json().id).toBe(s.ghsaFinding);
    expect(viaOther!.json().id).toBe(s.pysecFinding);
    const lead = viaLead!.json();
    expect({ ...viaOther!.json(), id: lead.id }).toEqual(lead);
    expect(lead).toMatchObject({
      purl: s.purl,
      version: "1.0.0",
      ecosystem: "PyPI",
      scope: "required",
      status: "open",
      groupId: expect.any(String),
      vulnerability: {
        id: s.ghsa,
        source: "ghsa",
        summary: "GitHub summary",
        cvssScore: 9.8,
        cvssVersion: "3.1",
        severityCategory: "critical",
        cvssSource: { source: "osv" },
      },
      membersTruncated: false,
    });
    expect(lead.members.map((m: { id: string }) => m.id)).toEqual([s.ghsaFinding, s.pysecFinding]);
    expect(lead.members[0]).toMatchObject({
      matchQuality: "confirmed",
      matcherVersion: 1,
      evidence: { rule: "range", comparator: "pep440", package: "trac" },
      advisory: {
        source: "ghsa",
        aliases: ["CVE-2026-0001"],
        detailsTruncated: false,
        refsTruncated: false,
        refs: [],
      },
    });
  });

  it("returns only the affected entries that match this package, through the correlator's name rule", async () => {
    const s = await seedGroup();
    // "Trac" matches the dependency `trac` by PEP 503 name, not by raw string.
    await affected(
      s.ghsa,
      "Trac",
      [
        ["introduced", "0"],
        ["fixed", "1.2.0"],
      ],
      ["1.0.0"],
    );
    await affected(s.ghsa, "other-package", [["introduced", "0"]]);

    const { members } = (
      await get(detailUrl(s.org.id, s.slug, s.ghsaFinding), s.admin.headers)
    ).json();

    expect(members[0].advisory.affected).toEqual([
      {
        packageName: "Trac",
        versions: ["1.0.0"],
        versionsTruncated: false,
        ranges: [
          {
            type: "ECOSYSTEM",
            events: [
              { type: "introduced", version: "0" },
              { type: "fixed", version: "1.2.0" },
            ],
          },
        ],
      },
    ]);
    expect(members[1].advisory.affected).toEqual([]);
  });

  it("shows an ungrouped advisory as a single member with a null group", async () => {
    const project = await newProject();
    const importId = await importFor(project.org.id, project.projectId, project.admin.id);
    const id = await finding({
      orgId: project.org.id,
      projectId: project.projectId,
      importId,
      purl: "pkg:pypi/solo@1",
    });

    const body = (
      await get(detailUrl(project.org.id, project.slug, id), project.admin.headers)
    ).json();

    expect(body.groupId).toBeNull();
    expect(body.members.map((m: { id: string }) => m.id)).toEqual([id]);
  });

  it("labels resolved findings and withdrawn advisories and keeps unverifiable evidence as stored", async () => {
    const project = await newProject();
    const importId = await importFor(project.org.id, project.projectId, project.admin.id);
    const base = { orgId: project.org.id, projectId: project.projectId, importId };
    const vulnerabilityId = await advisory("WITHDRAWN");
    await pool.query(
      "UPDATE vulnerabilities SET withdrawn_at = '2026-02-03T00:00:00Z' WHERE id = $1",
      [vulnerabilityId],
    );
    const id = await finding({
      ...base,
      purl: "pkg:pypi/old@1",
      vulnerabilityId,
      status: "resolved",
      quality: "unverifiable",
    });

    const body = (
      await get(detailUrl(project.org.id, project.slug, id), project.admin.headers)
    ).json();

    expect(body.status).toBe("resolved");
    expect(body.members[0]).toMatchObject({
      status: "resolved",
      resolvedReason: "dependency_removed",
      resolvedAt: expect.any(String),
      matchQuality: "unverifiable",
      matchReason: "version_unparseable",
      advisory: { withdrawnAt: "2026-02-03T00:00:00.000Z" },
    });
  });

  it("bounds members, refs, details and versions, says so, and always includes the requested member", async () => {
    const project = await newProject();
    const importId = await importFor(project.org.id, project.projectId, project.admin.id);
    const base = { orgId: project.org.id, projectId: project.projectId, importId };
    const purl = "pkg:pypi/trac@1.0.0";
    await dependency(base, purl);
    const advisories = [];
    for (let i = 0; i < 52; i++) advisories.push(await advisory(`BIG-${i}`));
    await group(advisories[0]!, ...advisories.slice(1));
    const ids: string[] = [];
    for (const [i, vulnerabilityId] of advisories.entries()) {
      ids.push(
        await finding({
          ...base,
          purl,
          vulnerabilityId,
          firstSeen: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        }),
      );
    }
    const last = ids.at(-1)!;
    await pool.query(
      `UPDATE vulnerabilities SET details = repeat('x', 70000),
         refs = (SELECT jsonb_agg(jsonb_build_object('type', 'WEB', 'url', 'https://example.test/' || n))
                 FROM generate_series(1, 60) n)
       WHERE id = $1`,
      [advisories.at(-1)],
    );
    await affected(
      advisories.at(-1)!,
      "Trac",
      [],
      Array.from({ length: 250 }, (_, n) => `0.${n}`),
    );

    const body = (
      await get(detailUrl(project.org.id, project.slug, last), project.admin.headers)
    ).json();

    expect(body.membersTruncated).toBe(true);
    expect(body.members).toHaveLength(51);
    expect(body.members.map((m: { id: string }) => m.id)).toEqual([...ids.slice(0, 50), last]);
    const { advisory: big } = body.members.at(-1);
    expect(big.detailsTruncated).toBe(true);
    expect(big.details).toHaveLength(65536);
    expect(big.refsTruncated).toBe(true);
    expect(big.refs).toHaveLength(50);
    expect(big.refs[0]).toEqual({ type: "WEB", url: "https://example.test/1" });
    expect(big.affected[0].versionsTruncated).toBe(true);
    expect(big.affected[0].versions).toHaveLength(200);
    const small = (
      await get(detailUrl(project.org.id, project.slug, ids[0]!), project.admin.headers)
    ).json();
    expect(small.members).toHaveLength(50);
    expect(small.membersTruncated).toBe(true);
  });

  it("caps details at 64 KiB of UTF-8, never splitting a character, and flags only a real cut", async () => {
    const s = await seedGroup();
    const url = detailUrl(s.org.id, s.slug, s.ghsaFinding);
    const details = async (sql: string) => {
      await pool.query(`UPDATE vulnerabilities SET details = ${sql} WHERE id = $1`, [s.ghsa]);
      return (await get(url, s.admin.headers)).json().members[0].advisory;
    };

    // 3-byte characters: 65536 is not a multiple of 3, so a naive byte cut would split one.
    const euro = await details("repeat('€', 30000)");
    expect(euro.detailsTruncated).toBe(true);
    expect(euro.details).toBe("€".repeat(21845));
    expect(Buffer.byteLength(euro.details)).toBeLessThanOrEqual(65536);

    // 60,000 bytes in 30,000 characters is under the cap: nothing is cut or flagged.
    const small = await details("repeat('é', 30000)");
    expect(small.detailsTruncated).toBe(false);
    expect(small.details).toBe("é".repeat(30000));

    // Exactly at the cap is not truncated; one byte over is.
    expect((await details("repeat('x', 65536)")).detailsTruncated).toBe(false);
    expect((await details("repeat('x', 65537)")).detailsTruncated).toBe(true);
  });

  it("treats refs that are not an array as empty instead of failing", async () => {
    const s = await seedGroup();
    for (const refs of ["'{}'", "'\"text\"'", "'null'", "'7'"]) {
      await pool.query(`UPDATE vulnerabilities SET refs = ${refs}::jsonb WHERE id = $1`, [s.ghsa]);
      const res = await get(detailUrl(s.org.id, s.slug, s.ghsaFinding), s.admin.headers);
      expect(res.statusCode, refs).toBe(200);
      const { advisory } = res.json().members[0];
      expect(advisory.refs).toEqual([]);
      expect(advisory.refsTruncated).toBe(false);
    }
  });

  it("copes with malformed refs from the source", async () => {
    const s = await seedGroup();
    await pool.query(
      `UPDATE vulnerabilities SET refs = '[{"type": null, "url": "javascript:alert(1)"}, {"url": 5}, 7, null]' WHERE id = $1`,
      [s.ghsa],
    );

    const { members } = (
      await get(detailUrl(s.org.id, s.slug, s.ghsaFinding), s.admin.headers)
    ).json();

    expect(members[0].advisory.refs).toEqual([
      { type: null, url: "javascript:alert(1)" },
      { type: null, url: null },
      { type: null, url: null },
      { type: null, url: null },
    ]);
  });

  it("reports KEV details when listed, and no claim when the group has no CVE to look up", async () => {
    const s = await seedGroup();
    const cve = `CVE-2026-${parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16)}`;
    await pool.query("UPDATE vulnerabilities SET aliases = ARRAY[$1] WHERE id = $2", [
      cve,
      s.pysec,
    ]);
    await pool.query(
      `INSERT INTO normalization_runs (artifact_sha256, source, ecosystem, adapter_version, status, correlation_id)
       VALUES ($1, 'cisa-kev', 'none', 1, 'published', $2)`,
      [randomUUID().replaceAll("-", "").padEnd(64, "a"), `test-${run}`],
    );
    await pool.query(
      `INSERT INTO kev_entries (cve_id, vendor_project, product, name, required_action, known_ransomware_use,
         date_added, due_date, content_hash, catalog_version, date_released, source_artifact_sha256, adapter_version)
       VALUES ($1, 'Acme', 'Trac', 'Acme Trac RCE', 'Patch it', 'Known', '2026-01-02', '2026-01-23', $2, 'v1', now(), $2, 1)`,
      [cve, "b".repeat(64)],
    );
    const url = detailUrl(s.org.id, s.slug, s.ghsaFinding);

    const listed = (await get(url, s.admin.headers)).json();
    expect(listed.kevStatus).toBe("listed");
    expect(listed.kev).toEqual([
      {
        cveId: cve,
        vendorProject: "Acme",
        product: "Trac",
        name: "Acme Trac RCE",
        dateAdded: "2026-01-02",
        dueDate: "2026-01-23",
        knownRansomwareUse: "Known",
        requiredAction: "Patch it",
        catalogVersion: "v1",
      },
    ]);

    await pool.query("UPDATE kev_entries SET removed_at = now() WHERE cve_id = $1", [cve]);
    const removed = (await get(url, s.admin.headers)).json();
    expect(removed).toMatchObject({ kevStatus: "not_listed", kev: null });

    await pool.query("UPDATE vulnerabilities SET aliases = '{}' WHERE id = ANY($1)", [
      [s.ghsa, s.pysec],
    ]);
    const unlinked = (await get(url, s.admin.headers)).json();
    expect(unlinked).toMatchObject({ kevStatus: "unavailable", kev: null });
  });

  it("returns the same 404 for malformed, unknown, other-project and other-tenant ids", async () => {
    const mine = await newProject();
    const theirs = await seedGroup();
    const otherProject = await app.inject({
      method: "POST",
      url: `/v1/orgs/${mine.org.id}/projects`,
      headers: mine.admin.headers,
      payload: { name: "other", slug: "other" },
    });
    expect(otherProject.statusCode).toBe(201);
    const importId = await importFor(mine.org.id, mine.projectId, mine.admin.id);
    const sibling = await finding({
      orgId: mine.org.id,
      projectId: mine.projectId,
      importId,
      purl: "pkg:pypi/sibling@1",
    });
    const attempts = [
      "not-a-uuid",
      randomUUID(),
      sibling, // exists, but in the project the URL does not name
      theirs.ghsaFinding, // another tenant's
    ];

    const results = await Promise.all(
      attempts.map((id) => get(detailUrl(mine.org.id, "other", id), mine.admin.headers)),
    );

    for (const res of results) {
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain(theirs.purl);
      expect(res.body).not.toContain(theirs.org.id);
    }
    const shapes = results.map((r) => ({ ...r.json(), correlationId: undefined }));
    expect(new Set(shapes.map((s) => JSON.stringify(s))).size).toBe(1);
    // The sibling is reachable in its own project.
    expect(
      (await get(detailUrl(mine.org.id, mine.slug, sibling), mine.admin.headers)).statusCode,
    ).toBe(200);
    // The other tenant's id does not resolve in the caller's matching project either.
    expect(
      (await get(detailUrl(mine.org.id, mine.slug, theirs.ghsaFinding), mine.admin.headers))
        .statusCode,
    ).toBe(404);
  });

  it("requires a signed-in user", async () => {
    const s = await seedGroup();
    expect((await get(detailUrl(s.org.id, s.slug, s.ghsaFinding))).statusCode).toBe(401);
  });
});
