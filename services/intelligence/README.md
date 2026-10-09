# Local investigation worker

SENTRA-17 runs the Python worker in Docker and oMLX natively on macOS. The worker calls `http://host.docker.internal:8000/v1/chat/completions` with the key from the local, gitignored `infra/docker/.env`. The API's default `INVESTIGATION_MODEL_ID` is `Qwen 3.8:27b`, the name advertised by this installation's authenticated `/v1/models` endpoint for the selected Qwen 3.8 27B MLX model. Set that variable to the served ID if your oMLX installation uses a different alias. Do not put the key in a tracked file.

1. Start oMLX with its authenticated server on port 8000. Confirm `GET /v1/models` lists the desired served ID.
2. Put `OMLX_API_KEY` and `INTELLIGENCE_DB_PASSWORD` in `infra/docker/.env` (copied from `.env.example` and gitignored).
3. Run `task stack:up`, start the API so migration 011 is applied, then run `task stack:intelligence-role` and `task stack:intelligence:up`.
4. Start the API and web app with their usual Task commands. From a project page, open Investigations, select an open finding, and start a run. The page polls status. The worker persists a private draft on success; the draft is not exposed by this story.

The API can start while oMLX or the worker is down. Queued rows remain durable. The worker periodically scans due rows as well as consuming Redpanda events, so a missed event does not strand a run. Defaults: one concurrent model call across workers, five pending runs per organization, three attempts, 90 second model timeout, 180 second lease, up to 64 KiB input snapshot and 16 KiB output draft. These are provisional capacity limits, not product SLOs.

Worker metrics are available at `http://localhost:9106/metrics` when the Docker worker is up. The port is bound to loopback and can be changed with `INTELLIGENCE_METRICS_PUBLISHED_PORT`.

`task intelligence:lint`, `task intelligence:typecheck`, and `task intelligence:test` check the Python worker. The integration tests for the API need the local Postgres stack and `infra/docker/.env.sentra`. Keep `OMLX_API_KEY` out of commands and logs.
