// Shared helpers for the API test files.

/** The identity header the test authenticators trust in place of a bearer token. */
const TEST_USER_HEADER = "x-test-user";

/**
 * The authenticator's request type only declares `authorization`, so the test-only header is
 * found by name rather than by an index the type does not have.
 */
export function testUserId(headers: { authorization?: string }): string | undefined {
  return Object.entries(headers).find(([name]) => name === TEST_USER_HEADER)?.[1];
}

/** The structured-log fields the tests assert on. */
export type LogLine = {
  message?: string;
  orgId?: string;
  userId?: string;
  reason?: string;
  invitationId?: string;
  requestIp?: string;
};
