/**
 * Audit actions the API records today (string literals in `apps/api/src`). The Action filter's
 * datalist only suggests these; any value is accepted, so a new API action needs no web change.
 */
export const KNOWN_AUDIT_ACTIONS = [
  "org.created",
  "invitation.create",
  "invitation.created",
  "invitation.accepted",
  "invitation.revoked",
  "member.left",
  "member.removed",
  "member.role_changed",
  "project.create",
  "project.created",
  "sbom.upload_initiated",
  "sbom.upload_completed",
  "investigation.create",
  "investigation.created",
] as const;
