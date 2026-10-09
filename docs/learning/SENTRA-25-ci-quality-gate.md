# SENTRA-25: CI quality gate on pull requests

## What was built

- `.github/workflows/ci.yml`: one job, `check`, on pull requests to `main` and pushes to `main`. It installs tools from `mise.toml` and runs `task setup` then `task check:full`.
- `task security:history`: a gitleaks scan of `origin/main..HEAD`, now part of `check:full`.
- `.github/rulesets/main.json` and `task github:ruleset`: a committed repository ruleset and an idempotent `gh api` apply (find by name, PUT or POST).

## Why it is designed this way

- **CI runs the local command.** The YAML holds no check logic, so "green locally" and "green in CI" mean the same thing, and the log shows which Task command failed.
- **One job, one required context.** Parallel jobs would be faster, but `check:full` takes about half a minute locally, and one name is simpler to require.
- **History scan, not only a tree scan.** `gitleaks dir` misses a secret that was committed and removed in a later commit of the same PR. The secret stays in history after merge.
- **Fail closed.** gitleaks exits 0 with "0 commits scanned" when the base ref is missing (verified on 8.30.1), so the task checks the ref itself. A misconfigured checkout turns red instead of silently green.
- **Pinned everything.** Actions use full commit SHAs (a tag can move), mise is pinned through its `version` input, and `UV_LOCKED=1` plus `CI=true` make lockfile drift a failure.
- **Ruleset pinned to the Actions app.** `integration_id: 15368` stops another app or a plain commit status named `check` from satisfying the gate.

## Alternatives considered

- Per-category matrix jobs: parallel, but many contexts to require and logic spread into YAML.
- `pull_request_target`: runs fork code with base-repo privileges. Rejected on a public repo.
- Path filters: a required check that never reports on filtered PRs blocks them forever.
- Classic branch protection, UI clicks, or Terraform: less reviewable, or new infrastructure.
- A dependency cache step: dropped for now (see below).

## Tradeoffs and scaling implications

- No parallelism. Revisit if p50 stays over 5 minutes.
- `fetch-depth: 0` grows with history. If checkout exceeds about 60 s, consider `--filter=blob:none`.
- Strict status checks make a PR update its branch when `main` moves, which re-runs `check`.
- 0 required approvals and no bypass actors: a single-maintainer repo cannot approve its own PR, but nobody, including the admin, can skip the check. If the gate is stuck (for example Actions is down), the ruleset has no bypass actors, so an admin sets `enforcement` to `disabled` in Settings > Rules (or in the JSON and `task github:ruleset`) to unblock, then restores it.
- The `actions/cache` step for the pnpm store and uv cache was left out. Only `jdx/mise-action`'s tool cache is used. Add the cache only if measured runs show a saving of at least 30 s.

## Failure and security considerations

- `pull_request` runs the PR's own workflow, so a PR can weaken the gate. This is an accepted risk for now. CODEOWNERS on `.github/` is a follow-up.
- Pre-commit hygiene hooks do not run in CI. `git diff --check HEAD` is a no-op on a clean checkout. Running `pre-commit run --from-ref origin/main --to-ref HEAD` in `check:full` is a follow-up.
- Bootstrap order: apply the ruleset only after the PR adding `ci.yml` has merged with a green `check`. Otherwise PRs wait forever for a status that never reports.
- The job has `contents: read`, uses no secrets, and gitleaks runs with `--redact` because the logs are public.
- Integration, e2e and tenant-isolation suites are not in the gate (they need the Docker stack). SENTRA-21 depends on a later job.

## Key concepts

- Required status check context: a name contract between the workflow and the ruleset.
- Fail closed: a check that cannot run must fail, not pass.
- Supply-chain pinning: SHA-pinned actions, pinned tool versions, frozen lockfiles.
- Merge commit checkout: `pull_request` tests `refs/pull/N/merge`, so the tested tree is what would merge. Strict mode keeps it so.
