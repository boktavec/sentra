"use server";

import { apiGet, apiPost } from "@/lib/api";
import { callApi } from "@/lib/auth";
import {
  investigationsPath,
  listInvestigationFindings,
  type Finding,
  type Investigation,
  type Page,
} from "@/lib/investigations";

export async function moreFindings(orgId: string, slug: string, cursor: string) {
  return listInvestigationFindings(orgId, slug, cursor) as Promise<
    | { ok: true; data: Page<Finding>; status: number }
    | { ok: false; status: number; correlationId: string; code?: string }
  >;
}

export async function runsForFinding(
  orgId: string,
  slug: string,
  findingId: string,
  cursor?: string,
) {
  return callApi((token) =>
    apiGet<Page<Investigation>>(
      `${investigationsPath(orgId, slug, findingId)}?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      token,
    ),
  );
}

export async function startInvestigation(orgId: string, slug: string, findingId: string) {
  return callApi((token) =>
    apiPost<Investigation>(investigationsPath(orgId, slug, findingId), token, undefined),
  );
}
