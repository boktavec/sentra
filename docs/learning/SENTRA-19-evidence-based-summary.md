# SENTRA-19: Evidence-based investigation summary

## What was built

A completed investigation now ends in a structured, validated result that project members can read, instead of an unchecked plain-text draft. The page shows three things apart: facts retrieved from the project and security data (priority, KEV, CVSS, dependency), the model's explanation (summary, impact, claims with links to their evidence, next steps), and what is missing (gaps the API detected, plus the model's own uncertainties).

- **Contract:** `investigation-result.v1.json` defines what the model may write. Everything else in the stored result is written by the API.
- **API:** a new internal `complete` route validates the model's JSON against the tool-call ledger, assembles facts, evidence and gaps, stores one immutable row in `investigation_results` and completes the run in one transaction. A member-scoped `GET .../result` route reads it.
- **Worker:** prompt version 3 embeds the schema, numbers every successful tool result as `call:<n>`, posts the answer to `complete` and gets one repair turn if the API rejects it.
- **Web:** the investigations workspace gains a "View summary" button per completed run.

## Why it is designed this way

- **Separate the claim from the fact.** A language model is good at wording and unreliable at facts. So the model never writes the severity, KEV status, priority or CVSS the reader sees: the API copies them from what the tools returned. If the model's prose disagrees, the authoritative values sit right next to it.
- **A citation you can check.** The model cites `call:3`, a number the API gave it, not a database id. The API verifies the number is a successful call from this investigation and attempt. A model cannot cite another tenant's data because it was never given another tenant's numbers, and an invented number is simply rejected.
- **Validate where the evidence lives.** The worker is not the authority on what the tools returned; the API wrote the ledger. So the worker only forwards the answer and the API decides, in the same transaction that stores the result. The stored result is therefore always valid and never edited.
- **Gaps are rules, not model honesty.** A forgetful model could omit "the advisory was not found". The API derives those gaps from ledger facts (a `not_found` outcome, a truncated result, no CVSS, a weak match) so they appear whatever the model says. The model still must state its own uncertainty, because only it knows what it was unsure about.
- **One repair turn, then fail.** Local models often make small format mistakes. One retry with a fixed, typed message recovers most of them cheaply; a second failure is a terminal `invalid_output` rather than a loop.

## Alternatives considered

- Plain text plus an evidence list: simplest, but individual statements cannot be checked.
- The model cites domain ids: it could name data it never retrieved.
- An LLM judge as a second pass: costs a model slot and adds a second non-deterministic reviewer. Deferred until measurements justify it.
- Validate at read time or in the worker: the stored result could be invalid, or the validator would not be the authority on the evidence.
- Keep rejected model output for debugging: a larger private-data surface and new retention debt. The violation code is logged instead.

## Tradeoffs

- The API cannot catch a wrong sentence that cites a valid call. This is a measured, documented limitation, not a solved problem.
- No rejected output is kept, so debugging a bad run means reproducing it. Only the violation code is logged.
- Tool rounds drop from three to two by default, so the answer and the repair both fit the existing four-round budget. Each round can still make several calls.
- A new private copy of tenant data (the result) under the same undefined retention as drafts and the ledger.

## Scaling implications

One result row per run, at most 32 KiB, written in a transaction that already holds the run's advisory lock; reads are a primary-key lookup scoped by org, project and finding. The added cost per run is one internal call plus at most one repair model turn. With one global model slot the API sees a trickle. All caps (rounds, calls, sizes) remain provisional until measured.

## Failure and security considerations

- `complete` needs the service secret, a run token and a live lease; org, project and finding come from the run row. A stale lease is `409 lease_lost` and writes nothing. A repeat after success returns `ok` without a second write.
- The model cannot supply scope or any API-written field: it is rejected as `forbidden_field`. Injection text in advisory data can mislead wording, but it cannot change scope, the schema or the citation check, and it only ever reaches the model inside tool messages. The repair message uses fixed wording so nothing untrusted is echoed back.
- Another tenant, a missing run and a run with no result are one identical `404`, and the new routes are in the tenant isolation suite.
- Prompts, answers, results and tokens are never logged or used as metric labels. Logs carry ids, the outcome and violation codes.
- Rollback needs the v3 runbook: the previous worker would run version 3 runs on the plain-draft path.

## Key concepts to understand

- Grounding means each statement is tied to retrieved evidence; it does not prove the statement is true.
- Authority sits with whoever owns the evidence. Here that is the API and its ledger.
- Idempotent completion: a crash after the commit must not produce a second result.
- A bounded repair loop is a cheap reliability tool for a probabilistic component; the cap keeps it from becoming a retry storm.
- Defense in depth for untrusted text: keep it in data channels, validate outputs by contract, and keep authority out of the model's reach.
