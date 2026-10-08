// Real Postgres, real routes, real nodemailer, and the real Mailpit container from the local stack
// (SMTP on :1025, API on :8025). Nothing about email is faked: an SMTP outage is a real transport
// pointed at a closed port. Identity and Zitadel's userinfo are faked as in the other suites.
// Needs `task stack:up`. Run with `task api:test:integration`.
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { createTransport } from "nodemailer";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createLogger, unauthenticated } from "@sentra/ts-platform";
import { buildApp } from "./app.ts";
import { createEmailSender, type MailTransport } from "./email-sender.ts";
import { createInvitationStore } from "./invitations.ts";
import { createMemberStore } from "./members.ts";
import { migrate } from "./migrate.ts";
import { createProjectStore } from "./projects.ts";
import { createOrgStore } from "./orgs.ts";
import type { Profile } from "./profile.ts";
import { createUserStore } from "./users.ts";

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) throw new Error("DATABASE_URL is required (see `task api:test:integration`)");
const smtp = new URL(process.env["SMTP_URL"] ?? "smtp://127.0.0.1:1025");
const MAILPIT = process.env["MAILPIT_URL"] ?? "http://127.0.0.1:8025";
const WEB_URL = "http://localhost:3000";

const logLines: Record<string, unknown>[] = [];
const logger = createLogger("api-test", {
  level: "debug",
  destination: new Writable({
    write(chunk, _enc, done) {
      logLines.push(JSON.parse(chunk.toString()));
      done();
    },
  }),
});

let pool: Pool;
let app: ReturnType<typeof buildApp>;
const run = randomUUID().slice(0, 8);
const profiles = new Map<string, Profile>();

const mailpit = createTransport({ host: smtp.hostname, port: Number(smtp.port) });
// Nothing listens on port 1, so every send fails with ECONNREFUSED.
const deadSmtp = createTransport({ host: "127.0.0.1", port: 1, connectionTimeout: 1000 });

const senderFor = (
  transport: MailTransport,
  overrides: Partial<{ maxAttempts: number; leaseSeconds: number }> = {},
) =>
  createEmailSender(pool, {
    transport,
    from: "Sentra <no-reply@sentra.test>",
    logger,
    maxAttempts: 5,
    leaseSeconds: 60,
    backoffBaseSeconds: 30,
    ...overrides,
  });

interface TestUser {
  id: string;
  email: string;
  headers: Record<string, string>;
}

async function newUser(label: string): Promise<TestUser> {
  const email = `${label}-${run}@example.com`;
  const user = await createUserStore(pool).resolve({
    issuer: "http://email.test",
    subject: randomUUID(),
  });
  profiles.set(user.id, { email, emailVerified: true });
  return {
    id: user.id,
    email,
    headers: { "x-test-user": user.id, authorization: `Bearer ${user.id}` },
  };
}

async function newOrg(admin: TestUser, name = "Team") {
  const res = await app.inject({
    method: "POST",
    url: "/v1/orgs",
    headers: admin.headers,
    payload: { name, slug: `em-${randomUUID().slice(0, 12)}` },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; slug: string };
}

const invite = (admin: TestUser, orgId: string, email: string, role = "member") =>
  app.inject({
    method: "POST",
    url: `/v1/orgs/${orgId}/invitations`,
    headers: admin.headers,
    payload: { email, role },
  });
const accept = (who: TestUser, token: string) =>
  app.inject({
    method: "POST",
    url: "/v1/invitations/accept",
    headers: who.headers,
    payload: { token },
  });

async function sendInvitation(admin: TestUser, orgId: string, invitee: TestUser, role = "member") {
  const res = await invite(admin, orgId, invitee.email, role);
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; token: string };
}

const emailRow = async (invitationId: string) =>
  (
    await pool.query(
      "SELECT * FROM invitation_emails WHERE invitation_id = $1 ORDER BY created_at",
      [invitationId],
    )
  ).rows;
const makeDue = (invitationId: string) =>
  pool.query("UPDATE invitation_emails SET next_attempt_at = now() WHERE invitation_id = $1", [
    invitationId,
  ]);

/** Messages Mailpit holds for an address, waiting briefly for delivery to show up. */
async function inbox(address: string, expected: number) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const found = await (
      await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`)
    ).json();
    if ((found.messages?.length ?? 0) >= expected) {
      return Promise.all(
        (found.messages as { ID: string }[]).map(async (m) =>
          (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json(),
        ),
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return [];
}
/** Nothing was delivered: wait a moment (sends are fast), then check once. */
async function expectNoMail(address: string) {
  await new Promise((r) => setTimeout(r, 300));
  const found = await (
    await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`)
  ).json();
  expect(found.messages ?? []).toHaveLength(0);
}
const linkIn = (message: { Text: string }) =>
  /(http:\/\/localhost:3000\/invitations\/accept\?token=([A-Za-z0-9_-]{43}))/.exec(message.Text)!;

beforeAll(async () => {
  pool = new Pool({ connectionString: databaseUrl, max: 20 });
  await migrate(pool);
  const userStore = createUserStore(pool);
  app = buildApp({
    logger,
    orgs: createOrgStore(pool, { maxOrgsPerUser: 100 }),
    members: createMemberStore(pool),
    projects: createProjectStore(pool),
    invitations: createInvitationStore(pool, {
      limits: { ttlHours: 168, maxPending: 50, maxPerDay: 50, maxMembers: 100 },
      webUrl: WEB_URL,
      fetchProfile: async (token) => profiles.get(token) ?? { emailVerified: false },
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
// Emails left over from other tests or files would otherwise be sent by these senders.
beforeEach(() =>
  pool.query(
    "UPDATE invitation_emails SET status = 'cancelled', body = NULL WHERE status = 'pending'",
  ),
);
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("queueing", () => {
  it("writes the email in the same transaction as the invitation", async () => {
    const [admin, invitee] = [await newUser("q-admin"), await newUser("q-invitee")];
    const org = await newOrg(admin, "Queue Co");
    const sent = await sendInvitation(admin, org.id, invitee, "admin");

    const [row] = await emailRow(sent.id);
    expect(row).toMatchObject({ status: "pending", attempts: 0 });
    expect(row.subject).toBe("You're invited to join Queue Co on Sentra");
    expect(row.body).toContain(`${WEB_URL}/invitations/accept?token=${sent.token}`);
    expect(row.body).toContain("as an admin");
    expect(row.body).toContain(invitee.email);
  });

  it("leaves no email behind when the invitation transaction fails", async () => {
    const [admin, invitee] = [await newUser("rb-admin"), await newUser("rb-invitee")];
    const org = await newOrg(admin);
    await pool.query(`CREATE OR REPLACE FUNCTION fail_email_audit() RETURNS trigger AS $$
      BEGIN IF NEW.correlation_id = 'force-fail' THEN RAISE EXCEPTION 'forced'; END IF; RETURN NEW; END;
      $$ LANGUAGE plpgsql`);
    await pool.query(
      "CREATE TRIGGER fail_email_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_email_audit()",
    );
    try {
      const res = await app.inject({
        method: "POST",
        url: `/v1/orgs/${org.id}/invitations`,
        headers: { ...admin.headers, "x-correlation-id": "force-fail" },
        payload: { email: invitee.email, role: "member" },
      });
      expect(res.statusCode).toBe(500);
    } finally {
      await pool.query("DROP TRIGGER fail_email_audit ON audit_events");
      await pool.query("DROP FUNCTION fail_email_audit()");
    }
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM invitations i JOIN invitation_emails e ON e.invitation_id = i.id WHERE i.org_id = $1",
      [org.id],
    );
    expect(rows[0].n).toBe(0);
  });
});

describe("delivery", () => {
  it("sends the email through SMTP, the link in it works, and the stored link is cleared", async () => {
    const [admin, invitee] = [await newUser("d-admin"), await newUser("d-invitee")];
    const org = await newOrg(admin, "Delivery Co");
    const sent = await sendInvitation(admin, org.id, invitee);

    expect(await senderFor(mailpit).tick()).toBeGreaterThanOrEqual(1);

    const [message] = await inbox(invitee.email, 1);
    expect(message.Subject).toBe("You're invited to join Delivery Co on Sentra");
    expect(message.From.Address).toBe("no-reply@sentra.test");
    expect(message.To[0].Address).toBe(invitee.email);
    expect(message.Text).toContain("Delivery Co");
    expect(message.Text).toContain("as a member");
    expect(message.Text).toContain("expires on");
    expect(message.Text).not.toContain(admin.email);

    // The emailed link is the real one: it carries the token that accepts the invitation.
    const [, , token] = linkIn(message);
    expect(token).toBe(sent.token);
    expect((await accept(invitee, token!)).statusCode).toBe(200);

    const [row] = await emailRow(sent.id);
    expect(row).toMatchObject({ status: "sent", body: null, attempts: 1, last_error: null });
    expect(row.sent_at).not.toBeNull();
  });

  it("sends each email exactly once when several senders run at the same time", async () => {
    const admin = await newUser("c-admin");
    const org = await newOrg(admin);
    const invitees = await Promise.all(Array.from({ length: 12 }, (_, i) => newUser(`c-${i}`)));
    for (const invitee of invitees) await sendInvitation(admin, org.id, invitee);

    const handled = await Promise.all([
      senderFor(mailpit).tick(),
      senderFor(mailpit).tick(),
      senderFor(mailpit).tick(),
    ]);
    expect(handled.reduce((a, b) => a + b, 0)).toBe(12);
    for (const invitee of invitees) {
      expect(await inbox(invitee.email, 1)).toHaveLength(1);
    }
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM invitation_emails e JOIN invitations i ON i.id = e.invitation_id
       WHERE i.org_id = $1 AND e.status = 'sent' AND e.attempts = 1`,
      [org.id],
    );
    expect(rows[0].n).toBe(12);
  });

  it("delivers on a timer when started, and stops cleanly", async () => {
    const [admin, invitee] = [await newUser("t-admin"), await newUser("t-invitee")];
    const org = await newOrg(admin);
    await sendInvitation(admin, org.id, invitee);

    const sender = senderFor(mailpit);
    sender.start(50);
    expect(await inbox(invitee.email, 1)).toHaveLength(1);
    await sender.stop();
  });
});

describe("outages and retries", () => {
  it("keeps the email and retries with backoff while SMTP is down, then delivers when it returns", async () => {
    const [admin, invitee] = [await newUser("o-admin"), await newUser("o-invitee")];
    const org = await newOrg(admin);
    const sent = await sendInvitation(admin, org.id, invitee);

    expect(await senderFor(deadSmtp).tick()).toBeGreaterThanOrEqual(1);
    const [failed] = await emailRow(sent.id);
    expect(failed).toMatchObject({ status: "pending", attempts: 1, last_error: "ESOCKET" });
    expect(failed.body).toContain(sent.token);
    expect(failed.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 20_000);
    await expectNoMail(invitee.email);

    // Not due yet: another sender leaves it alone.
    const before = (await emailRow(sent.id))[0].attempts;
    await senderFor(mailpit).tick();
    expect((await emailRow(sent.id))[0].attempts).toBe(before);

    await makeDue(sent.id);
    await senderFor(mailpit).tick();
    expect(await inbox(invitee.email, 1)).toHaveLength(1);
    expect((await emailRow(sent.id))[0]).toMatchObject({ status: "sent", attempts: 2, body: null });
  });

  it("backs off exponentially, up to an hour", async () => {
    const [admin, invitee] = [await newUser("b-admin"), await newUser("b-invitee")];
    const org = await newOrg(admin);
    const sent = await sendInvitation(admin, org.id, invitee);
    const sender = senderFor(deadSmtp, { maxAttempts: 20 });

    const delays: number[] = [];
    for (let i = 0; i < 9; i++) {
      await makeDue(sent.id);
      await sender.tick();
      const [row] = await emailRow(sent.id);
      delays.push(Math.round((row.next_attempt_at.getTime() - Date.now()) / 1000));
    }
    // 30s, 60s, 120s ... doubling, capped at 3600s (allowing a second of clock skew).
    const expected = [30, 60, 120, 240, 480, 960, 1920, 3600, 3600];
    delays.forEach((delay, i) => expect(Math.abs(delay - expected[i]!)).toBeLessThanOrEqual(2));
  });

  it("gives up after the maximum attempts and clears the stored link", async () => {
    const [admin, invitee] = [await newUser("g-admin"), await newUser("g-invitee")];
    const org = await newOrg(admin);
    const sent = await sendInvitation(admin, org.id, invitee);
    const sender = senderFor(deadSmtp, { maxAttempts: 3 });

    for (let i = 0; i < 3; i++) {
      await makeDue(sent.id);
      await sender.tick();
    }
    const [row] = await emailRow(sent.id);
    expect(row).toMatchObject({
      status: "failed",
      attempts: 3,
      body: null,
      last_error: "ESOCKET",
    });

    await makeDue(sent.id);
    expect(await senderFor(mailpit).tick()).toBe(0);
    await expectNoMail(invitee.email);
    const text = (await app.inject({ method: "GET", url: "/metrics" })).body;
    expect(text).toContain('email_failed_total{reason="ESOCKET"}');
  });
});

describe("invitations that stopped being valid", () => {
  it("does not email a revoked invitation", async () => {
    const [admin, invitee] = [await newUser("v-admin"), await newUser("v-invitee")];
    const org = await newOrg(admin);
    const sent = await sendInvitation(admin, org.id, invitee);
    await app.inject({
      method: "DELETE",
      url: `/v1/orgs/${org.id}/invitations/${sent.id}`,
      headers: admin.headers,
    });

    await senderFor(mailpit).tick();
    expect((await emailRow(sent.id))[0]).toMatchObject({ status: "cancelled", body: null });
    await expectNoMail(invitee.email);
  });

  it("emails only the newest invitation when an address is invited twice", async () => {
    const [admin, invitee] = [await newUser("p-admin"), await newUser("p-invitee")];
    const org = await newOrg(admin);
    const first = await sendInvitation(admin, org.id, invitee);
    const second = await sendInvitation(admin, org.id, invitee);

    await senderFor(mailpit).tick();
    expect((await emailRow(first.id))[0].status).toBe("cancelled");
    const messages = await inbox(invitee.email, 1);
    expect(messages).toHaveLength(1);
    expect(linkIn(messages[0])[2]).toBe(second.token);
  });

  it("does not email an expired invitation", async () => {
    const [admin, invitee] = [await newUser("x-admin"), await newUser("x-invitee")];
    const org = await newOrg(admin);
    const sent = await sendInvitation(admin, org.id, invitee);
    await pool.query(
      "UPDATE invitations SET expires_at = now() - interval '1 second' WHERE id = $1",
      [sent.id],
    );

    await senderFor(mailpit).tick();
    expect((await emailRow(sent.id))[0].status).toBe("cancelled");
    await expectNoMail(invitee.email);
  });
});

describe("crashes and slow sends", () => {
  it("hides a claimed email from other senders, and retries it if the lease runs out (at-least-once)", async () => {
    const [admin, invitee] = [await newUser("l-admin"), await newUser("l-invitee")];
    const org = await newOrg(admin);
    const sent = await sendInvitation(admin, org.id, invitee);

    // The first sender claims the email, then its SMTP call hangs (a stand-in for a stalled process).
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const hanging: MailTransport = {
      sendMail: async (mail) => (await gate, mailpit.sendMail(mail)),
    };
    const first = senderFor(hanging).tick();
    await expect.poll(async () => (await emailRow(sent.id))[0].attempts, { timeout: 3000 }).toBe(1);

    // While it is leased, another sender cannot take it.
    expect(await senderFor(mailpit).tick()).toBe(0);
    await expectNoMail(invitee.email);

    // The lease runs out: another sender delivers it...
    await makeDue(sent.id);
    await senderFor(mailpit).tick();
    expect(await inbox(invitee.email, 1)).toHaveLength(1);
    // ...and when the stalled one finally finishes, the email goes out again. A duplicate invitation
    // email is harmless, and the row still ends up as `sent` with the link cleared.
    release();
    await first;
    expect(await inbox(invitee.email, 2)).toHaveLength(2);
    expect((await emailRow(sent.id))[0]).toMatchObject({ status: "sent", body: null });
  });
});

describe("secrets and observability", () => {
  it("never logs tokens or addresses, and exposes counters and queue gauges", async () => {
    const [admin, invitee] = [await newUser("s-admin"), await newUser("s-invitee")];
    const org = await newOrg(admin);
    logLines.length = 0;
    const sent = await sendInvitation(admin, org.id, invitee);
    await senderFor(deadSmtp).tick();
    await makeDue(sent.id);
    await senderFor(mailpit).tick();

    const logs = JSON.stringify(logLines);
    expect(logs).not.toContain(sent.token);
    expect(logs).not.toContain(invitee.email);
    expect(logLines.some((l) => l["message"] === "email_retry" && l["orgId"] === org.id)).toBe(
      true,
    );
    expect(
      logLines.some((l) => l["message"] === "email_sent" && l["invitationId"] === sent.id),
    ).toBe(true);

    const text = (await app.inject({ method: "GET", url: "/metrics" })).body;
    for (const name of [
      "email_sent_total",
      "email_retries_total",
      "email_queue_depth",
      "email_oldest_pending_age_seconds",
    ]) {
      expect(text).toContain(name);
    }
  });
});
