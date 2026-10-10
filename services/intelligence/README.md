# Local investigation worker

SENTRA-17 runs the Python worker in Docker and oMLX natively on macOS. The worker calls `http://host.docker.internal:8000/v1/chat/completions` with the key from the local, gitignored `infra/docker/.env`. The API's default `INVESTIGATION_MODEL_ID` is `Qwen 3.8:27b`, the name advertised by this installation's authenticated `/v1/models` endpoint for the selected Qwen 3.8 27B MLX model. Set that variable to the served ID if your oMLX installation uses a different alias. Do not put the key in a tracked file.

1. Start oMLX with its authenticated server on port 8000. Confirm `GET /v1/models` lists the desired served ID.
2. Put `OMLX_API_KEY` and `INTELLIGENCE_DB_PASSWORD` in `infra/docker/.env` (copied from `.env.example` and gitignored).
3. Run `task stack:up`, start the API so migrations are applied, then run `task stack:intelligence-role` and `task stack:intelligence:up`.
4. Start the API and web app with their usual Task commands. From a project page, open Investigations, select an open finding, and start a run. The page polls status. On success a version 3 run stores a validated structured result that members read from the run's page (see Evidence-based results below); runs queued before SENTRA-19 keep a private draft that no API exposes.

The API can start while oMLX or the worker is down. Queued rows remain durable. The worker periodically scans due rows as well as consuming Redpanda events, so a missed event does not strand a run. Defaults: one concurrent model call across workers, five pending runs per organization, three attempts, 90 second model timeout, 180 second lease, up to 64 KiB input snapshot and 16 KiB output draft. These are provisional capacity limits, not product SLOs.

Worker metrics are available at `http://localhost:9106/metrics` when the Docker worker is up. The port is bound to loopback and can be changed with `INTELLIGENCE_METRICS_PUBLISHED_PORT`.

`task intelligence:lint`, `task intelligence:typecheck`, and `task intelligence:test` check the Python worker. The integration tests for the API need the local Postgres stack and `infra/docker/.env.sentra`. Keep `OMLX_API_KEY` out of commands and logs.

## Investigation tools (SENTRA-18)

New runs (`prompt_version = 2`) let the model call four read-only tools through the API's internal listener ([ADR 0009](../../docs/adr/0009-tenant-safe-investigation-tools.md), [contracts](../../packages/contracts/ai-tools.md)). The worker never reads tenant tables; its database role is unchanged except for `attempt_deadline_at`. Runs queued before the upgrade (`prompt_version = 1`) finish on the old single call.

Setup, in addition to the steps above:

1. Generate two secrets and put the same `INTELLIGENCE_TOOL_TOKEN` in `infra/docker/.env.sentra` (API) and `infra/docker/.env` (worker). The signing keys go in `.env.sentra` only. Both must be at least 32 bytes. Commands are in the contracts doc; `task stack:bootstrap` now generates and preserves them in `.env.sentra` and prints the token to copy into `.env`.
2. Start the API: it serves the listener on `127.0.0.1:4001` (`INVESTIGATION_TOOLS_HOST`, `INVESTIGATION_TOOLS_PORT`) and refuses to start without the secrets.
3. `task stack:intelligence:up` rebuilds the worker image, which carries the tool contracts (compose passes them as a build context). The worker reaches the listener at `http://host.docker.internal:4001/internal/v1` (`INTELLIGENCE_TOOLS_URL`).

Order when deploying: migrate, then the new worker, then the new API. The worker handles both prompt versions and needs only `INTELLIGENCE_TOOL_TOKEN` to start, so it can run before the listener exists; the API starts stamping version 2 only after. Defaults (provisional, not product requirements): 4 model rounds (the last offers no tools), 8 tool calls per attempt, 5 second tool timeout, 600 second attempt deadline. The worker checks at startup that the 180 second lease outlasts the 90 second model timeout plus all tool timeouts.

Failures: an unreachable or erroring tool API ends the attempt as retryable `tool_unavailable`; a rejected credential ends it terminally as `tool_unauthorized`; passing the attempt deadline is retryable `deadline_exceeded`; a lost lease stops the worker without writing. Metrics add `investigation_tool_rounds` and the new outcome labels.

### Rolling back

The previous worker ignores `prompt_version` and would run version 2 rows with no tools. Before starting it:

1. Stop the worker.
2. Redeploy the previous API, which stamps `prompt_version = 1` again.
3. Run [`runbooks/rollback-prompt-v2.sql`](runbooks/rollback-prompt-v2.sql) against the database. It fails queued and running version 2 runs with `processing_error`; the tool ledger and finished runs stay. `task intelligence:test:integration` rehearses this against a scratch database.
4. Start the previous worker.

`task intelligence:test:integration` also checks the worker's SQL (claim, lease renewal, the new failure codes, role grants) against a scratch copy of the schema; it needs the local stack but not the model.

## Evidence-based results (SENTRA-19)

New runs (`prompt_version = 3`) use the same tools, but the model's final answer is one JSON object that follows [`investigation-result.v1.json`](../../packages/contracts/ai-tools/investigation-result.v1.json) ([ADR 0011](../../docs/adr/0011-validated-structured-investigation-results.md)). The worker posts it to `POST /internal/v1/investigations/:id/complete`; the API validates it against the run's tool-call ledger, adds the facts and gaps itself, stores it and completes the run. The worker no longer writes anything for these runs. Rounds: tools are offered in rounds 1 to N-2 (N = `INTELLIGENCE_MAX_TOOL_ROUNDS`, default 4), the answer is forced by round N-1, and round N is the single repair turn after an `invalid_result` reply. A second rejection fails the run `invalid_output`. The worker sends `max_tokens = 2048` for these turns and does not use `response_format`: the schema is in the prompt and the API is the validator.

Worker metric added: `investigation_repair_turns_total{outcome="recovered"|"failed"}`. The API exposes `investigation_result_outcomes_total{outcome}` and `investigation_result_violations_total{code}`; neither carries a tenant label, and no prompt, answer or token is logged.

### Rolling back from version 3

The previous worker would run version 3 rows on the plain-draft path. After stopping the worker and redeploying the previous API (which stamps version 2 again), run [`runbooks/rollback-prompt-v3.sql`](runbooks/rollback-prompt-v3.sql). It fails queued and running version 3 runs with `processing_error`; finished runs and their stored results stay. `task intelligence:test:integration` rehearses it against a scratch database.
