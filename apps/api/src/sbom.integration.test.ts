// Real Postgres, real SeaweedFS, real Redpanda, real routes. Only identity is faked (`x-test-user`
// picks a real user row, as in projects.integration.test.ts). Uploads go through the actual
// presigned POST. Needs the local stack: `task api:test:integration` (S3_* and KAFKA_BOOTSTRAP set).
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import {
  Consumer,
  MessagesStreamModes,
  Producer,
  stringDeserializers,
  stringSerializers,
} from "@platformatic/kafka";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger, unauthenticated } from "@sentra/ts-platform";
import { buildApp } from "./app.ts";
import { createInvitationStore } from "./invitations.ts";
import { createMemberStore } from "./members.ts";
import { migrate } from "./migrate.ts";
import { createOrgStore } from "./orgs.ts";
import { createProjectStore } from "./projects.ts";
import { createSbomRelay, ensureDevTopic, type EventPublisher } from "./sbom-relay.ts";
import { reprocess } from "./sbom-reprocess.ts";
import { createSbomStorage } from "./sbom-storage.ts";
import { createSbomStore } from "./sbom.ts";
import { createUserStore } from "./users.ts";

const need = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required (see \`task api:test:integration\`)`);
  return value;
};
const databaseUrl = need("DATABASE_URL");
const kafka = need("KAFKA_BOOTSTRAP").split(",");
const storage = createSbomStorage({
  endpoint: need("S3_ENDPOINT"),
  bucket: process.env["S3_BUCKET"] ?? "sentra-raw",
  accessKey: need("S3_ACCESS_KEY"),
  secretKey: need("S3_SECRET_KEY"),
});

const MAX = 1000;
const PENDING_CAP = 3;
const limits = { maxBytes: MAX, uploadTtlSeconds: 900, maxPendingPerProject: PENDING_CAP };

const logger = createLogger("api-test", {
  level: "debug",
  destination: new Writable({ write: (_chunk, _enc, done) => done() }),
});

let pool: Pool;
let app: ReturnType<typeof buildApp>;
let sbomStore: ReturnType<typeof createSbomStore>;
const run = randomUUID().slice(0, 8);

type Headers = Record<string, string>;
interface Created {
  id: string;
  status: string;
  upload: { url: string; fields: Record<string, string> };
}

async function newUser() {
  const user = await createUserStore(pool).resolve({
    issuer: "http://sbom.test",
    subject: randomUUID(),
  });
  return { id: user.id, headers: { "x-test-user": user.id } };
}

/** An org with an admin, a plain member and one project, set up through the API and SQL. */
async function newOrgWithProject() {
  const admin = await newUser();
  const member = await newUser();
  const res = await app.inject({
    method: "POST",
    url: "/v1/orgs",
    headers: admin.headers,
    payload: { name: "Team", slug: `team-${run}-${randomUUID().slice(0, 8)}` },
  });
  expect(res.statusCode).toBe(201);
  const org: { id: string } = res.json();
  await pool.query("INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'member')", [
    org.id,
    member.id,
  ]);
  const slug = "web-app";
  const project = await app.inject({
    method: "POST",
    url: `/v1/orgs/${org.id}/projects`,
    headers: admin.headers,
    payload: { name: "Web", slug },
  });
  expect(project.statusCode).toBe(201);
  return { org, admin, member, slug, projectId: project.json().id as string };
}
type Ctx = Awaited<ReturnType<typeof newOrgWithProject>>;

const base = (c: Pick<Ctx, "org" | "slug">) => `/v1/orgs/${c.org.id}/projects/${c.slug}/sboms`;
const create = (
  c: Ctx,
  headers: Headers,
  payload: unknown = { filename: "bom.json", size_bytes: 10 },
) => app.inject({ method: "POST", url: base(c), headers, payload: payload as object });
const complete = (c: Pick<Ctx, "org" | "slug">, id: string, headers: Headers) =>
  app.inject({ method: "POST", url: `${base(c)}/${id}/complete`, headers });
const get = (url: string, headers: Headers) => app.inject({ method: "GET", url, headers });
const count = async (sql: string, params: unknown[]) =>
  (await pool.query(sql, params)).rows[0].n as number;

/** The browser's step: POST the signed form fields, then the file last, straight to storage. */
async function upload(created: Created, body: string | Uint8Array) {
  const form = new FormData();
  for (const [k, v] of Object.entries(created.upload.fields)) form.append(k, v);
  form.append("file", new Blob([body as BlobPart]), "bom.json");
  return fetch(created.upload.url, { method: "POST", body: form });
}

async function createAndUpload(c: Ctx, headers: Headers, body = '{"bomFormat":"CycloneDX"}') {
  const res = await create(c, headers);
  expect(res.statusCode).toBe(201);
  const created: Created = res.json();
  expect((await upload(created, body)).status).toBe(204);
  return created;
}

beforeAll(async () => {
  pool = new Pool({ connectionString: databaseUrl, max: 20 });
  await migrate(pool);
  await storage.ensureDevBucket("http://localhost:3000");
  sbomStore = createSbomStore(pool, { storage, limits });
  const userStore = createUserStore(pool);
  app = buildApp({
    logger,
    orgs: createOrgStore(pool, { maxOrgsPerUser: 100 }),
    members: createMemberStore(pool),
    projects: createProjectStore(pool),
    sbom: sbomStore,
    sbomMaxBytes: MAX,
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
  storage.destroy();
});

describe("the upload flow", () => {
  it("creates an import, accepts the upload, completes it, and queues the event and audit atomically", async () => {
    const c = await newOrgWithProject();
    const created = await createAndUpload(c, c.member.headers);
    expect(created.status).toBe("pending_upload");
    expect(created.upload.fields["key"]).toBe(`sbom/${c.org.id}/${c.projectId}/${created.id}.json`);

    const done = await complete(c, created.id, c.member.headers);
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ id: created.id, status: "uploaded", sizeBytes: 25 });

    const row = (await pool.query("SELECT * FROM sbom_imports WHERE id = $1", [created.id]))
      .rows[0];
    expect(row).toMatchObject({
      org_id: c.org.id,
      project_id: c.projectId,
      created_by: c.member.id,
    });
    const outbox = (
      await pool.query("SELECT * FROM sbom_outbox WHERE import_id = $1", [created.id])
    ).rows;
    expect(outbox).toHaveLength(1);
    expect(outbox[0].payload).toMatchObject({
      type: "sbom.uploaded",
      version: 1,
      importId: created.id,
      orgId: c.org.id,
      projectId: c.projectId,
      artifact: { key: row.object_key, sizeBytes: 25 },
    });
    const audit = (
      await pool.query("SELECT * FROM audit_events WHERE target_id = $1", [created.id])
    ).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      org_id: c.org.id,
      actor_user_id: c.member.id,
      action: "sbom.upload_completed",
      target_type: "sbom_import",
    });
  });

  it("ignores tenant, key, status and actor fields sent in the body", async () => {
    const c = await newOrgWithProject();
    const other = await newOrgWithProject();
    const res = await create(c, c.admin.headers, {
      filename: "bom.json",
      size_bytes: 10,
      org_id: other.org.id,
      object_key: "sbom/evil",
      status: "validated",
      created_by: other.admin.id,
    });
    expect(res.statusCode).toBe(201);
    const row = (await pool.query("SELECT * FROM sbom_imports WHERE id = $1", [res.json().id]))
      .rows[0];
    expect(row).toMatchObject({
      org_id: c.org.id,
      status: "pending_upload",
      created_by: c.admin.id,
    });
    expect(row.object_key).toBe(`sbom/${c.org.id}/${c.projectId}/${row.id}.json`);
  });

  it.each([
    ["empty filename", { filename: "", size_bytes: 10 }],
    ["not .json", { filename: "bom.xml", size_bytes: 10 }],
    ["path in filename", { filename: "../bom.json", size_bytes: 10 }],
    ["control characters", { filename: "bo\nm.json", size_bytes: 10 }],
    ["zero size", { filename: "bom.json", size_bytes: 0 }],
    ["fractional size", { filename: "bom.json", size_bytes: 1.5 }],
    ["string size", { filename: "bom.json", size_bytes: "10" }],
    ["over the cap", { filename: "bom.json", size_bytes: MAX + 1 }],
    ["missing fields", {}],
  ])("rejects invalid input: %s", async (_name, payload) => {
    const c = await newOrgWithProject();
    const res = await create(c, c.admin.headers, payload);
    expect(res.statusCode).toBe(400);
    expect(
      await count("SELECT count(*)::int AS n FROM sbom_imports WHERE org_id = $1", [c.org.id]),
    ).toBe(0);
  });

  it("has storage reject a body over the signed cap, so complete finds nothing", async () => {
    const c = await newOrgWithProject();
    const res = await create(c, c.admin.headers);
    const created: Created = res.json();
    const refused = await upload(created, "x".repeat(MAX + 500));
    expect(refused.status).toBe(400);
    const done = await complete(c, created.id, c.admin.headers);
    expect(done.statusCode).toBe(409);
    expect(done.json().type).toContain("upload_missing");
  });

  it("has storage reject a form whose key was changed", async () => {
    const c = await newOrgWithProject();
    const created: Created = (await create(c, c.admin.headers)).json();
    const forged = {
      ...created,
      upload: {
        ...created.upload,
        fields: { ...created.upload.fields, key: "sbom/other/evil.json" },
      },
    };
    expect((await upload(forged, "{}")).status).toBeGreaterThanOrEqual(400);
  });

  it("returns 409 upload_missing when nothing was uploaded, and the import stays pending", async () => {
    const c = await newOrgWithProject();
    const created: Created = (await create(c, c.admin.headers)).json();
    const res = await complete(c, created.id, c.admin.headers);
    expect(res.statusCode).toBe(409);
    expect(
      (await pool.query("SELECT status FROM sbom_imports WHERE id = $1", [created.id])).rows[0]
        .status,
    ).toBe("pending_upload");
  });

  it("completes idempotently: repeats and parallel calls yield one event and one audit row", async () => {
    const c = await newOrgWithProject();
    const created = await createAndUpload(c, c.admin.headers);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => complete(c, created.id, c.admin.headers)),
    );
    for (const r of results) {
      expect(r.statusCode).toBe(200);
      expect(r.json().status).toBe("uploaded");
    }
    expect((await complete(c, created.id, c.admin.headers)).statusCode).toBe(200);
    expect(
      await count("SELECT count(*)::int AS n FROM sbom_outbox WHERE import_id = $1", [created.id]),
    ).toBe(1);
    expect(
      await count("SELECT count(*)::int AS n FROM audit_events WHERE target_id = $1", [created.id]),
    ).toBe(1);
  });

  it("rolls everything back when the audit insert fails", async () => {
    const c = await newOrgWithProject();
    const created = await createAndUpload(c, c.admin.headers);
    const fn = `fail_audit_${run}_${randomUUID().slice(0, 6)}`;
    await pool.query(
      `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
         IF NEW.org_id = '${c.org.id}' THEN RAISE EXCEPTION 'forced'; END IF; RETURN NEW; END $$`,
    );
    await pool.query(
      `CREATE TRIGGER ${fn} BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
    );
    try {
      expect((await complete(c, created.id, c.admin.headers)).statusCode).toBe(500);
    } finally {
      await pool.query(`DROP TRIGGER ${fn} ON audit_events`);
      await pool.query(`DROP FUNCTION ${fn}()`);
    }
    expect(
      (await pool.query("SELECT status FROM sbom_imports WHERE id = $1", [created.id])).rows[0]
        .status,
    ).toBe("pending_upload");
    expect(
      await count("SELECT count(*)::int AS n FROM sbom_outbox WHERE import_id = $1", [created.id]),
    ).toBe(0);
    // And it can still be completed afterwards.
    expect((await complete(c, created.id, c.admin.headers)).statusCode).toBe(200);
  });
});

describe("abuse limits and expiry", () => {
  it("allows at most the configured number of pending imports per project, even in parallel", async () => {
    const c = await newOrgWithProject();
    const results = await Promise.all(
      Array.from({ length: PENDING_CAP + 4 }, () => create(c, c.admin.headers)),
    );
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(PENDING_CAP);
    expect(results.filter((r) => r.statusCode === 429)).toHaveLength(4);
    // Another project in the same org has its own allowance.
    const second = await app.inject({
      method: "POST",
      url: `/v1/orgs/${c.org.id}/projects`,
      headers: c.admin.headers,
      payload: { name: "Other", slug: "other-app" },
    });
    expect(second.statusCode).toBe(201);
    expect((await create({ ...c, slug: "other-app" }, c.admin.headers)).statusCode).toBe(201);
  });

  it("expires overdue pending imports, deletes their object, and refuses a late complete", async () => {
    const c = await newOrgWithProject();
    const created = await createAndUpload(c, c.admin.headers);
    const key = created.upload.fields["key"]!;
    expect(await storage.size(key)).toBe(25);
    await pool.query(
      "UPDATE sbom_imports SET expires_at = now() - interval '1 second' WHERE id = $1",
      [created.id],
    );

    // A late complete is refused even before the sweep runs.
    expect((await complete(c, created.id, c.admin.headers)).statusCode).toBe(409);
    expect(await sbomStore.expirePending()).toBeGreaterThanOrEqual(1);
    expect(await storage.size(key)).toBeUndefined();
    const res = await complete(c, created.id, c.admin.headers);
    expect(res.statusCode).toBe(409);
    expect(res.json().type).toContain("expired");
    expect((await get(`${base(c)}/${created.id}`, c.admin.headers)).json().status).toBe("expired");
  });

  it("does not count expired pending imports against the cap", async () => {
    const c = await newOrgWithProject();
    for (let i = 0; i < PENDING_CAP; i++)
      expect((await create(c, c.admin.headers)).statusCode).toBe(201);
    expect((await create(c, c.admin.headers)).statusCode).toBe(429);
    await pool.query(
      "UPDATE sbom_imports SET expires_at = now() - interval '1 second' WHERE project_id = $1",
      [c.projectId],
    );
    expect((await create(c, c.admin.headers)).statusCode).toBe(201);
  });
});

describe("reading imports", () => {
  it("lists newest first with cursor pagination, and gets by id", async () => {
    const c = await newOrgWithProject();
    const ids: string[] = [];
    for (let i = 0; i < PENDING_CAP; i++) ids.push((await create(c, c.admin.headers)).json().id);
    const first = await get(`${base(c)}?limit=2`, c.member.headers);
    expect(first.statusCode).toBe(200);
    expect(first.json().items.map((i: { id: string }) => i.id)).toEqual([ids[2], ids[1]]);
    const second = await get(
      `${base(c)}?limit=2&cursor=${first.json().nextCursor}`,
      c.member.headers,
    );
    expect(second.json().items.map((i: { id: string }) => i.id)).toEqual([ids[0]]);
    expect(second.json().nextCursor).toBeNull();

    const one = await get(`${base(c)}/${ids[0]}`, c.member.headers);
    expect(one.json()).toMatchObject({
      id: ids[0],
      filename: "bom.json",
      status: "pending_upload",
      reasonCode: null,
    });
    expect(one.json()).not.toHaveProperty("objectKey");
    expect(one.json()).not.toHaveProperty("object_key");
  });

  it("reports dependency counts once the pipeline has parsed an import", async () => {
    const c = await newOrgWithProject();
    const id = (await create(c, c.admin.headers)).json().id;
    expect((await get(`${base(c)}/${id}`, c.member.headers)).json()).toMatchObject({
      dependencyCount: null,
      skippedCount: null,
    });
    await pool.query(
      "UPDATE sbom_imports SET status = 'parsed', dependency_count = 12, skipped_count = 3 WHERE id = $1",
      [id],
    );
    const one = await get(`${base(c)}/${id}`, c.member.headers);
    expect(one.json()).toMatchObject({ status: "parsed", dependencyCount: 12, skippedCount: 3 });
    const listed = await get(base(c), c.member.headers);
    expect(listed.json().items[0]).toMatchObject({ dependencyCount: 12, skippedCount: 3 });
  });

  it("rejects a bad cursor", async () => {
    const c = await newOrgWithProject();
    expect((await get(`${base(c)}?cursor=garbage`, c.admin.headers)).statusCode).toBe(400);
  });
});

describe("reprocessing a stored import", () => {
  async function parsedImport() {
    const c = await newOrgWithProject();
    const id = (await create(c, c.admin.headers)).json().id;
    await pool.query(
      "UPDATE sbom_imports SET status = 'parsed', size_bytes = 25, dependency_count = 1, skipped_count = 0 WHERE id = $1",
      [id],
    );
    await pool.query(
      `INSERT INTO sbom_dependencies (import_id, org_id, project_id, purl, purl_type, name, version, scope, occurrences)
       VALUES ($1, $2, $3, 'pkg:npm/a@1', 'npm', 'a', '1', 'required', 1)`,
      [id, c.org.id, c.projectId],
    );
    return { c, id };
  }

  it("clears the old result and queues one sbom.uploaded for the same object", async () => {
    const { c, id } = await parsedImport();

    expect(await reprocess(pool, id, "sentra-raw")).toBe(true);

    const row = (await pool.query("SELECT * FROM sbom_imports WHERE id = $1", [id])).rows[0];
    expect(row).toMatchObject({ status: "uploaded", reason_code: null, dependency_count: null });
    expect(
      (await pool.query("SELECT 1 FROM sbom_dependencies WHERE import_id = $1", [id])).rowCount,
    ).toBe(0);
    const outbox = (await pool.query("SELECT payload FROM sbom_outbox WHERE import_id = $1", [id]))
      .rows;
    expect(outbox).toHaveLength(1);
    expect(outbox[0].payload).toMatchObject({
      type: "sbom.uploaded",
      importId: id,
      orgId: c.org.id,
      projectId: c.projectId,
      artifact: { key: row.object_key },
    });
  });

  it("leaves imports that are unknown or still in flight alone", async () => {
    const c = await newOrgWithProject();
    const pending = (await create(c, c.admin.headers)).json().id;

    expect(await reprocess(pool, pending, "sentra-raw")).toBe(false);
    expect(await reprocess(pool, randomUUID(), "sentra-raw")).toBe(false);

    const row = (await pool.query("SELECT status FROM sbom_imports WHERE id = $1", [pending]))
      .rows[0];
    expect(row.status).toBe("pending_upload");
    expect(
      (await pool.query("SELECT 1 FROM sbom_outbox WHERE import_id = $1", [pending])).rowCount,
    ).toBe(0);
  });
});

describe("tenant isolation", () => {
  it("answers a non-member with the same 404 as a missing org, on every route, and writes nothing", async () => {
    const a = await newOrgWithProject();
    const b = await newOrgWithProject();
    const mine = await createAndUpload(a, a.admin.headers);

    const attempts = [
      create(a, b.admin.headers),
      complete(a, mine.id, b.admin.headers),
      get(base(a), b.admin.headers),
      get(`${base(a)}/${mine.id}`, b.admin.headers),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.statusCode).toBe(404);
    }
    const missingOrg = await get(
      `/v1/orgs/${randomUUID()}/projects/web-app/sboms`,
      b.admin.headers,
    );
    expect((await get(base(a), b.admin.headers)).json().type).toBe(missingOrg.json().type);
    expect(
      await count("SELECT count(*)::int AS n FROM sbom_imports WHERE org_id = $1", [a.org.id]),
    ).toBe(1);
    expect(
      await count("SELECT count(*)::int AS n FROM sbom_outbox WHERE import_id = $1", [mine.id]),
    ).toBe(0);
  });

  it("does not resolve another org's import through your own org or project", async () => {
    const a = await newOrgWithProject();
    const b = await newOrgWithProject();
    const theirs = await createAndUpload(b, b.admin.headers);

    // Own org and project, their import ID.
    expect((await get(`${base(a)}/${theirs.id}`, a.admin.headers)).statusCode).toBe(404);
    expect((await complete(a, theirs.id, a.admin.headers)).statusCode).toBe(404);
    // Their org with your slug is a non-member 404 too.
    expect(
      (await get(`${base({ org: b.org, slug: a.slug })}/${theirs.id}`, a.admin.headers)).statusCode,
    ).toBe(404);
    // An import from one project is not visible under a sibling project of the same org.
    const sibling = await app.inject({
      method: "POST",
      url: `/v1/orgs/${b.org.id}/projects`,
      headers: b.admin.headers,
      payload: { name: "Sibling", slug: "sibling" },
    });
    expect(sibling.statusCode).toBe(201);
    expect(
      (await get(`${base({ org: b.org, slug: "sibling" })}/${theirs.id}`, b.admin.headers))
        .statusCode,
    ).toBe(404);
    expect(
      (await get(`${base({ org: b.org, slug: "sibling" })}`, b.admin.headers)).json().items,
    ).toEqual([]);
    // Malformed IDs are the same 404.
    expect((await get(`${base(a)}/not-a-uuid`, a.admin.headers)).statusCode).toBe(404);
    expect((await get(`${base(a)}/${randomUUID()}`, a.admin.headers)).statusCode).toBe(404);
    // Nothing of theirs changed.
    expect((await get(`${base(b)}/${theirs.id}`, b.admin.headers)).json().status).toBe(
      "pending_upload",
    );
  });

  it("needs authentication", async () => {
    const c = await newOrgWithProject();
    expect((await app.inject({ method: "GET", url: base(c) })).statusCode).toBe(401);
  });
});

describe("publishing sbom.uploaded", () => {
  it("relays the outbox row to Redpanda, marks it sent, and sends nothing twice", async () => {
    const c = await newOrgWithProject();
    const created = await createAndUpload(c, c.admin.headers);
    await complete(c, created.id, c.admin.headers);

    const topic = `sbom.uploaded.test-${randomUUID().slice(0, 8)}`;
    await ensureDevTopic(kafka, topic);
    const producer = new Producer({
      clientId: "sbom-test",
      bootstrapBrokers: kafka,
      serializers: stringSerializers,
    });
    const publisher: EventPublisher = {
      publish: async (t, key, value) =>
        void (await producer.send({ messages: [{ topic: t, key, value }] })),
    };
    const relay = createSbomRelay(pool, {
      publisher,
      logger,
      topic,
      leaseSeconds: 60,
      backoffBaseSeconds: 1,
    });
    try {
      // Other tests' rows share this table; drain until ours is sent.
      while ((await relay.tick()) > 0);
      const { rows } = await pool.query("SELECT sent_at FROM sbom_outbox WHERE import_id = $1", [
        created.id,
      ]);
      expect(rows[0].sent_at).not.toBeNull();
      expect(await relay.tick()).toBe(0);

      const consumer = new Consumer({
        groupId: `sbom-test-${randomUUID()}`,
        clientId: "sbom-test",
        bootstrapBrokers: kafka,
        deserializers: stringDeserializers,
      });
      try {
        const stream = await consumer.consume({
          topics: [topic],
          mode: MessagesStreamModes.EARLIEST,
          autocommit: false,
          sessionTimeout: 10_000,
          heartbeatInterval: 500,
        });
        const seen: { key: string; event: Record<string, unknown> }[] = [];
        for await (const message of stream) {
          seen.push({ key: message.key, event: JSON.parse(message.value) });
          if (seen.some((m) => m.key === created.id)) break;
        }
        const ours = seen.find((m) => m.key === created.id)!;
        expect(ours.event).toMatchObject({
          type: "sbom.uploaded",
          version: 1,
          importId: created.id,
          orgId: c.org.id,
        });
      } finally {
        await consumer.close(true);
      }
    } finally {
      await producer.close(true);
    }
  }, 60_000);

  it("keeps the event and backs off when the broker is unavailable, then publishes after it returns", async () => {
    const c = await newOrgWithProject();
    const created = await createAndUpload(c, c.admin.headers);
    await complete(c, created.id, c.admin.headers);
    await pool.query(
      "UPDATE sbom_outbox SET sent_at = now() WHERE sent_at IS NULL AND import_id <> $1",
      [created.id],
    );

    let down = true;
    const published: string[] = [];
    const publisher: EventPublisher = {
      publish: async (_topic, key) => {
        if (down) throw new Error("broker unavailable");
        published.push(key);
      },
    };
    const relay = createSbomRelay(pool, {
      publisher,
      logger,
      topic: "t",
      leaseSeconds: 60,
      backoffBaseSeconds: 1,
    });
    expect(await relay.tick()).toBe(0);
    const row = (await pool.query("SELECT * FROM sbom_outbox WHERE import_id = $1", [created.id]))
      .rows[0];
    expect(row).toMatchObject({ attempts: 1, sent_at: null });
    expect(row.next_attempt_at.getTime()).toBeGreaterThan(Date.now());

    down = false;
    await pool.query("UPDATE sbom_outbox SET next_attempt_at = now() WHERE import_id = $1", [
      created.id,
    ]);
    expect(await relay.tick()).toBe(1);
    expect(published).toEqual([created.id]);
  });

  it("does not hand one event to two relays at once", async () => {
    const c = await newOrgWithProject();
    const created = await createAndUpload(c, c.admin.headers);
    await complete(c, created.id, c.admin.headers);
    await pool.query(
      "UPDATE sbom_outbox SET sent_at = now() WHERE sent_at IS NULL AND import_id <> $1",
      [created.id],
    );

    const published: string[] = [];
    const publisher: EventPublisher = {
      publish: async (_t, key) => {
        await new Promise((r) => setTimeout(r, 100));
        published.push(key);
      },
    };
    const make = () =>
      createSbomRelay(pool, {
        publisher,
        logger,
        topic: "t",
        leaseSeconds: 60,
        backoffBaseSeconds: 1,
      });
    const sent = await Promise.all([make().tick(), make().tick(), make().tick()]);
    expect(sent.reduce((a, b) => a + b, 0)).toBe(1);
    expect(published).toEqual([created.id]);
  });
});
