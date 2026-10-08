import type { Role } from "./orgs.ts";

/** Plain text on purpose: the accept link is the only thing the recipient needs. */
export function invitationEmail(input: {
  orgName: string;
  role: Role;
  to: string;
  link: string;
  expiresAt: Date;
}) {
  const article = input.role === "admin" ? "an admin" : "a member";
  return {
    subject: `You're invited to join ${input.orgName} on Sentra`,
    body: [
      `You have been invited to join ${input.orgName} on Sentra as ${article}.`,
      "",
      "Accept the invitation:",
      input.link,
      "",
      `Sign in with this email address (${input.to}) to accept. The invitation expires on ${input.expiresAt.toISOString().slice(0, 10)}.`,
      "If you were not expecting it, you can ignore this email.",
      "",
    ].join("\n"),
  };
}
