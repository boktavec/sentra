# SENTRA-25: CI quality gate on pull requests

- Status: Draft
- YouTrack: http://localhost:8080/issue/SENTRA-25
- Owner: Sentra operator (admin)

## Problem and outcome

- Pull requests to `main` currently get no automated checks. `.github/` contains only the PR template, and `main` has no branch protection or rulesets (checked with `gh api repos/boktavec/sentra/rulesets` → `[]` and `.../branches/main/protection` → 404). Whether a PR has passed `task check:full` depends on someone remembering to run it.
- Done means:
  - Every PR to `main` runs one GitHub Actions job named `check`. The job runs the same Task commands a developer runs locally (`task setup`, then `task check:full`).
  - A red `check` blocks the merge through a committed repository ruleset.
  - Every command CI runs is listed in the README.

## Scope

- In scope:
  - `.github/workflows/ci.yml`: one job, `check`. Triggers are `pull_request` to `main` and `push` to `main`. The job only calls Task.
  - Tool versions come from `mise.toml` through `jdx/mise-action`. Every third-party action is pinned to a full commit SHA.
  - New task `security:history`: `gitleaks git` over the commit range `origin/main..HEAD`. It fails closed if the base ref is missing. It is added to `check:full`.
  - New task `github:ruleset`: an idempotent `gh api` apply of `.github/rulesets/main.json`, matched by ruleset name.
  - `.github/rulesets/main.json`: requires a PR, requires status `check` from GitHub Actions, and blocks force-push and deletion of `main`.
  - README: update the command list and the description of `check:full` so they match CI exactly.
  - A learning note: `docs/learning/SENTRA-25-ci-quality-gate.md`.
- Out of scope:
  - Integration, e2e, and tenant-isolation suites in CI. These need the Docker stack, so they belong in a later job or story. SENTRA-21 depends on this story for that.
  - Managing the ruleset with Terraform (deferred, possibly a separate story).
  - Running pre-commit hooks (`trailing-whitespace`, `end-of-file-fixer`, and so on) in CI. See Open questions.
  - Builds, deploys, release artifacts, CODEOWNERS, Dependabot or Renovate, and a merge queue.
- Dependencies and related stories:
  - Uses the existing `task setup`, `task check:full`, `task fallow`, and `task security`.
  - Unblocks per-PR runs for SENTRA-21 (tenant isolation) in a later job.

## Decisions and alternatives

| Decision | Chosen approach | Alternatives considered | Reason and tradeoff |
| --- | --- | --- | --- |
| Gate content | `task check:full`: format:check, lint, typecheck, unit tests, fallow audit, gitleaks dir, plus the new gitleaks history scan | `task check` only; check:full plus integration suites | Matches the documented pre-PR command. Integration suites need the Docker stack and would slow the gate a lot, so they are deferred. |
| Job layout | One job `check` that runs `task setup` and then `task check:full` | One job per category (lint, test, and so on) in a matrix | Gives one required status context and keeps no command logic in YAML. The cost: no parallelism, and a failure shows up in the log rather than in the check name. That is acceptable because `check:full` takes about 31 s locally. |
| Tool provisioning | `jdx/mise-action` reads `mise.toml`, with the `version` input set to an explicit mise release | `actions/setup-node`, `setup-python`, `pnpm/action-setup` and so on, one per tool | Keeps one source of truth for versions in local and CI. Pinning the mise version too makes the tool resolver reproducible. **Verified** (context7 `/jdx/mise-action` and `action.yml` on `jdx/mise-action` main): with no `version` input the action installs the newest mise release that satisfies `minimum_release_age` (default `24h`). It runs `mise install` by default and caches by default, and the cache key includes a hash of the mise config files. |
| Action pinning | Full commit SHAs, with the tag in a trailing comment. At planning time: `actions/checkout` v7.0.1 = `3d3c42e5aac5ba805825da76410c181273ba90b1`, `jdx/mise-action` v5.1.1 = `2d8d4cafcbd33be2ea37d2b6f5ad595363d1f1ca` | Major-version tags (`@v5`) | A tag can be moved, and the repo is public. **Verified** with `gh api repos/<action>/git/ref/tags/<tag>`. The implementer re-resolves these SHAs on the day of implementation. |
| mise-action major | v5.1.1 | v4, as shown in the context7 README snippets | **Verified** from the v5.1.1 release notes: the action no longer exports its token as `MISE_GITHUB_TOKEN` to later steps (`persist_github_token` defaults to `false`). Later steps only need tools that are already installed, so no token persistence is needed. |
| Triggers | `pull_request` (branches: `main`) and `push` (branches: `main`), with no path filters | `pull_request_target`; adding path filters | `pull_request_target` runs fork code with base-repo privileges, which is a known injection risk on a public repo. A path-filtered required check never reports on filtered PRs and blocks them forever. |
| Concurrency | `group: ci-${{ github.workflow }}-${{ github.event.pull_request.number \|\| github.sha }}`, `cancel-in-progress: ${{ github.event_name == 'pull_request' }}` | Cancel everything; no concurrency group | A new push to a PR supersedes the previous run. A run on `main` is never cancelled, so every merge commit gets a result. |
| Secret scanning | Keep `task security` (`gitleaks dir`, the working tree) and add `task security:history` (`gitleaks git --log-opts="origin/main..HEAD"`), called from `check:full` | Only the working tree; run the gitleaks GitHub Action | A secret committed and then deleted in a later PR commit stays in history after merge. `gitleaks dir` misses it. **Verified** in a scratch clone: a commit added a `ghp_` token and the next commit removed it. `gitleaks dir` reported no leaks. `gitleaks git --log-opts="origin/main..HEAD"` found 1 leak and exited 1, both on the branch and on a simulated `--no-ff` merge commit, which is what `pull_request` checks out. The gitleaks Action needs a license for org repos and duplicates the pinned binary. |
| Fail-closed history scan | `security:history` runs `git rev-parse --verify --quiet origin/main^{commit}` before scanning and exits non-zero with a clear message when the ref is missing | Trust gitleaks to error | **Verified** with gitleaks 8.30.1 in a shallow clone that has no `origin/main`: it printed "0 commits scanned … no leaks found" and **exited 0**. The gitleaks README says errors exit 1, but this case does not. Without the guard, a misconfigured checkout would pass silently. |
| Placing `security:history` | Inside `check:full`, so CI runs only `task setup` and `task check:full` | A separate CI step | Keeps CI identical to the local pre-PR command. Locally it scans unpushed and branch commits, which is useful before a push. |
| Fetch depth | `actions/checkout` with `fetch-depth: 0` | Depth 1; fetch only `main` | Both fallow and the history scan need `origin/main` and the merge base. **Verified**: without `origin/main`, `fallow audit --base origin/main` exits 2 with "could not determine changed files … shallow clone?". **Assumed** (actions/checkout behaviour): `fetch-depth: 0` creates `refs/remotes/origin/main`. The fail-closed guard and fallow's exit 2 both turn a wrong assumption into a red check, not a silent pass. |
| Fallow base | Keep `fallow audit --base origin/main` unchanged | Pass the PR base SHA from the event payload | **Verified**: fallow scopes by merge base (`origin/main...HEAD`). Moving `origin/main` ahead of the PR's merge base in a scratch clone still reported "1 changed file vs origin/main (<merge-base>..HEAD)". A newer main does not widen the audit. It also flagged an unused file added in the PR, on a merge commit, with exit 1. |
| Lockfile enforcement | Workflow `env`: `CI: true` (set by Actions) and `UV_LOCKED: "1"` | Add `--frozen-lockfile` and `--locked` to the setup tasks | A drifted lockfile must fail CI without changing local `task setup`. **Verified** in a scratch clone: `CI=true pnpm install` with a package.json change missing from the lockfile failed with `ERR_PNPM_OUTDATED_LOCKFILE`. `UV_LOCKED=1 uv sync` with a pyproject change missing from `uv.lock` exited 1 ("To update the lockfile, run `uv lock`"). Plain `uv sync` would quietly relock. |
| Dependency caching | Only `jdx/mise-action`'s default tool cache. No `actions/cache` step for the pnpm store or uv cache | A pinned `actions/cache` step keyed on `pnpm-lock.yaml` and `services/*/uv.lock` | Each cache action is one more SHA-pinned dependency, and the saving can't be measured before the first run. **Assumed**: a dependency cache would save 30 s or more. Measure the first runs, and add the step only if the saving is about 30 s or more. |
| Permissions | Workflow-level `permissions: contents: read`, no secrets used | The default token permissions | Least privilege. The job only reads code. |
| Enforcement mechanism | A repository ruleset as committed JSON, applied by `task github:ruleset` (`gh api`). Without an `id`, it does a GET of the list and matches by `name`, then PUT if found and POST if not | Classic branch protection; clicking in the UI; Terraform | The rule is reviewable and repeatable without new infrastructure. Applying it changes shared repo settings, so it runs by hand with explicit user approval and never from CI. |
| Ruleset content | Target `~DEFAULT_BRANCH`. Rules: `deletion`, `non_fast_forward`, `pull_request` (0 required approvals), and `required_status_checks` with `{context: "check", integration_id: 15368}`, `strict_required_status_checks_policy: true`. No bypass actors | Require approvals; non-strict status checks; admin bypass | This is a single-maintainer repo, and you cannot approve your own PR, so 0 approvals. Pinning the GitHub Actions app ID (15368) stops another app or a commit status named `check` from satisfying the gate. Strict mode makes the tested tree equal the merged tree, at the cost of updating the branch when main moves. **Assumed**: 15368 is the GitHub Actions app ID, strict mode is acceptable, and no bypass is wanted. See Open questions. |
| Job timeout | `timeout-minutes: 15` | The default 360 min | A hung test fails in 15 min instead of 6 h. That is about 5× the assumed cold run time. |

## Architecture and contracts

- Affected components and ownership:
  - Repo tooling only: `.github/workflows/ci.yml`, `.github/rulesets/main.json`, `Taskfile.yml`, `README.md`.
  - No application code changes.
  - The owner is the repo operator (admin).
- Request, event, and data flow:
  - PR opened, synchronized, or reopened against `main` (or a push to `main`) starts `ci.yml`, job `check` on `ubuntu-latest`. Its steps:
    1. `actions/checkout` with `fetch-depth: 0` checks out `refs/pull/N/merge` for PRs, or the pushed SHA.
    2. `jdx/mise-action` installs every tool in `mise.toml` and puts it on PATH.
    3. (No dependency cache step. mise-action caches tools. See Decisions.)
    4. `task setup`
    5. `task check:full`, which runs format:check → lint → typecheck → test → fallow → security → security:history.
  - The job result is reported as check run `check`. The ruleset requires it before merge.
- Contracts:
  - The status context name `check` is a contract between `ci.yml` (the job id or `name`) and `.github/rulesets/main.json`. Renaming one without the other blocks every PR. A comment in each file names the other.
  - Task interface: `task check:full` stays the single documented pre-PR command.
  - `task security:history` takes an optional `BASE` variable (default `origin/main`), so it can be run locally against another ref.
  - `task github:ruleset` reads the repo from `gh repo view` and needs an admin-scoped `gh` login.
- Compatibility and migration:
  - The ruleset has a bootstrap order problem. The UI only offers a required status check after that check has reported at least once. If the API is used earlier, every open PR shows "Expected — waiting for status to be reported" until the workflow exists on the PR's base. The ruleset is therefore applied only after the PR that adds `ci.yml` has run `check` green and has merged. That PR merges unprotected.
  - Once `main` requires the check, any PR branched before `ci.yml` existed on main must be updated from main before it can merge.

## Workload and targets

| Dimension | Expected value or range | Source or assumption | Validation |
| --- | --- | --- | --- |
| Traffic and peak requests | A few PR pushes per day plus one run per merge to main | Assumption: single maintainer plus agents | GitHub Actions run history after 2 weeks |
| Concurrent users or jobs | 1–3 concurrent runs. Superseded PR runs are cancelled | Assumption | Actions UI |
| Data size and growth | Repo history is small. A full fetch with `fetch-depth: 0` is seconds today and grows linearly with history | Measured locally: `gitleaks dir` scanned about 2.55 MB | Watch the checkout step duration. If it exceeds about 60 s, consider `--filter=blob:none` |
| Latency or throughput target | `check` p50 ≤ 5 min wall clock with a warm cache, ≤ 8 min cold. The hard timeout is 15 min | **Assumption, not a requirement.** Local baseline (measured): `task setup` about 2 s warm, `task check:full` 30.8 s on an Apple Silicon laptop. GitHub-hosted runners are slower, and a cold run adds tool and dependency downloads | Record the duration of the first 5 green runs (cold and warm) in the PR description. Revisit if p50 is over 5 min |
| Availability and recovery target | Depends on GitHub Actions availability. If Actions is down, PRs cannot merge (fail closed). Recovery is a re-run | Assumption | Manual re-run from the PR UI or `gh run rerun` |

## Edge cases and failure behavior

| Scenario | Expected behavior | Verification |
| --- | --- | --- |
| Fork PR | Runs under `pull_request` with a read-only token and no secrets. The job needs neither. GitHub's default for public repos asks the maintainer to approve workflow runs from first-time contributors. A fork PR cannot write the base-branch cache. Never use `pull_request_target` | Review of the workflow YAML. Optional: open a PR from a fork |
| Shallow clone or missing `origin/main` (checkout misconfigured) | `security:history` fails with a "base ref origin/main not found; fetch full history" message. `fallow` exits 2. The check goes red, not a false green | **Verified** (scratch shallow clone): without the guard gitleaks exits 0 with 0 commits scanned, and fallow exits 2. Unit-check the guard by running `task security:history BASE=origin/does-not-exist`, which must exit non-zero |
| Stale fallow base | In CI, `origin/main` is fetched fresh at checkout, and fallow uses the merge base, so a main that moved ahead does not widen the scope. Locally, a stale `origin/main` can only widen the scope (more files audited), never hide changes. README tells developers to run `git fetch origin` before `task check:full` | **Verified** in the scratch clone (see Decisions) |
| Main moves after the PR run | With strict status checks, GitHub requires "Update branch", which re-runs `check` on the new merge. Without strict mode, the merge commit is still checked by the `push` run on main | Verification step 6 |
| Push to `main` | Fallow sees 0 changed files and the history range is empty, so both pass trivially. Format, lint, typecheck, tests and `gitleaks dir` still run on the merged tree. That is the purpose of the main run | **Verified** locally: with HEAD == origin/main, fallow reports "0 changed files" and gitleaks git exits 0 |
| Secret committed and then removed within the PR | `security:history` fails, and the log shows the redacted finding with its commit SHA | **Verified** in the scratch clone. Repeated in verification step 5e |
| False positive from gitleaks | The author adds a `gitleaks:allow` comment or a `.gitleaksignore` fingerprint with a reason in the PR. Never disable the task | Review |
| Slow or hung step | The job is killed at 15 min and shows as failed (red). Re-run once. If it recurs, debug per the debugging skill | Check the timeout in the YAML |
| Flaky test | It fails the gate. Policy: re-run once at most. A second failure counts as a real failure. A known flaky test gets a YouTrack bug, and it is not skipped or retried in YAML | Documented in the learning note and the README |
| Tool download failure (mise or npm registry outage, GitHub rate limit) | The step fails red. Recovery is a re-run. mise-action uses the job token for GitHub-hosted tool downloads, which raises rate limits | Watch the first runs |
| New tool platform binaries on Linux (fallow's npm platform package; Python 3.14.8 prebuilt for linux-x64) | `mise install` gets them. If not, the mise step fails red | **Assumed** (only verified on macOS arm64). Validated by the first CI run |
| pyright's first run downloads its npm package | Needs network on the first run. Not cached unless the run proves slow | **Assumed**. Watch the first-run log |
| Lockfile drift | `task setup` fails (`ERR_PNPM_OUTDATED_LOCKFILE`, or uv exits 1) | **Verified** locally with `CI=true` and `UV_LOCKED=1` |
| `check` renamed in YAML but not in the ruleset | Every PR waits forever for `check` | Cross-reference comments. A reviewer checks both files change together |
| PR edits `ci.yml` to weaken the gate | `pull_request` runs the PR's own workflow version, so a PR could remove steps and still report `check` green | Accepted risk for a single-maintainer repo. Changes to `.github/` get reviewer attention. CODEOWNERS is listed as a future option |
| Ruleset bootstrap | Apply the ruleset only after the `ci.yml` PR has merged with a green `check`. See Architecture | Verification step 7 |
| `task github:ruleset` run twice | The second run PUTs the same JSON by id. Exactly one ruleset named `main` exists | Run twice and `gh api repos/{owner}/{repo}/rulesets` lists one |

## Security, observability, and rollout

- Authorization, tenant isolation, sensitive data, and abuse limits:
  - Workflow `permissions: contents: read`. No repository secrets are referenced.
  - `pull_request` only, never `pull_request_target`. All actions are SHA-pinned.
  - gitleaks runs with `--redact`, so findings never print secret values in public logs.
  - `github:ruleset` needs an admin `gh` token. It runs locally by the operator only and is never called from CI.
  - mise-action v5 does not persist its token to later steps (**Verified**, release notes).
  - No tenant data is involved.
- Logs, metrics, traces, and alerts:
  - Task prints each command (`task: [name] …`), so the CI log shows exactly which canonical command failed.
  - Step durations and run history in the Actions UI are the metrics. Record the first 5 run durations (cold and warm) in the PR.
  - GitHub's default notifications to the PR author and committer are the only alerting. No extra alerting is needed at this scale.
- Rollout, migration, rollback, and operational owner:
  1. Merge the PR adding `ci.yml`, the tasks, the ruleset JSON and the README (unprotected merge, after `check` is green on the PR).
  2. With explicit user approval, run `task github:ruleset`.
  3. Rollback of enforcement: set the ruleset's `enforcement` to `disabled` in the JSON and re-apply, or delete it in Settings → Rules. Rollback of CI is a revert PR, which itself must pass `check` while the ruleset is active.
  4. Owner: the repo operator (admin).

## Acceptance criteria

- [ ] A PR to `main` triggers exactly one job, `check`, which runs `task setup` and then `task check:full`. Each runs as its own step, and the workflow has no other `run:` commands.
- [ ] The `check` log shows format:check, lint, typecheck, test, fallow, security, and security:history each executing.
- [ ] All tool versions come from `mise.toml`. The mise version is pinned through mise-action's `version` input. Every `uses:` references a 40-character commit SHA.
- [ ] Separate deliberate PRs with (a) a formatting error, (b) a lint error, (c) a type error, (d) a failing unit test, (e) a secret committed and then deleted in a later commit, (f) a lockfile out of sync with its manifest, and (g) an unused exported file flagged by fallow each turn `check` red.
- [ ] With the ruleset applied, the merge button for a red `check` PR is blocked, and `gh pr merge` refuses without admin bypass. A green PR can merge.
- [ ] Force-push and deletion of `main` are rejected.
- [ ] `task security:history BASE=origin/does-not-exist` exits non-zero with a clear message. It never reports "no leaks" when the range could not be resolved.
- [ ] A push to a PR cancels that PR's in-progress run. Runs on `main` are never cancelled.
- [ ] `task github:ruleset` is idempotent. Running it twice leaves exactly one ruleset named `main`, matching `.github/rulesets/main.json`.
- [ ] The README command list contains every command CI runs (`task setup`, `task check:full`) and its components (`task fallow`, `task security`, `task security:history`), and it describes what `check:full` runs accurately.
- [ ] A green warm-cache `check` run finishes in ≤ 5 min. This is an assumption target: record the measured values and revisit, not a hard fail.

## Verification

- Manual checks and expected results:
  1. Run `task check:full` locally in the feature worktree after `git fetch origin`. It should be green, with the new `security:history` step visible.
  2. Open the feature PR. `check` should be green. Compare the log commands against the README list.
  3. Push a trivial second commit while the first run is in progress. The first run should be cancelled.
  4. Before merging, run `task security:history BASE=origin/does-not-exist`. It should exit non-zero.
  5. Open throwaway draft PRs from short-lived branches, one defect each, and expect `check` red with the named step failing:
     - a. A Prettier violation in `packages/ts-platform/src` → `format:check`.
     - b. An ESLint error (for example, an unused variable) → `lint`.
     - c. `const x: number = "a"` → `typecheck`.
     - d. A failing assertion in an existing vitest or pytest unit test → `test`.
     - e. Commit a generated `ghp_`-style token, then delete it in a second commit → `security:history`. Use a random non-real value. Never use a real credential. The redacted log must not show the value.
     - f. Add a dependency to a `package.json` without updating `pnpm-lock.yaml` → `task setup`.
     - g. Add an unreferenced `.ts` module → `fallow`.

     Close each PR and delete its branch afterwards. Branch history on the remote is deleted along with the branch, but the PR refs keep the fake token. That is why it must be fake.
  6. After the feature PR merges, confirm the `push` run on `main` is green.
  7. With user approval, run `task github:ruleset`, then run it again. `gh api repos/boktavec/sentra/rulesets` should show exactly one `main` ruleset. Reopen or re-run one red PR from step 5. The merge should be blocked in the UI, and `gh pr merge` should refuse. `git push --force` to `main` should be rejected.
- Automated tests and what they prove:
  - The gate itself is the test. No unit tests are added, because there is no application code.
  - Static checks: `actionlint` on `ci.yml` (run ad hoc through `mise exec` / `npx`, not added as a dependency unless the user agrees) and `python3 -m json.tool .github/rulesets/main.json`.
  - `task --list` must still parse; `task lint` already checks this.
- Load or failure tests, if relevant: steps 3, 4 and 5 are the failure tests. Record cold and warm run durations.

## Implementation steps

1. **Tasks** (no dependencies):
   - Add `security:history` to `Taskfile.yml`. Add `vars: BASE: '{{.BASE | default "origin/main"}}'`, a ref guard that fails closed, and `gitleaks git --no-banner --redact --log-opts="{{.BASE}}..HEAD" .`.
   - Append `security:history` to `check:full`.
   - Add `github:ruleset` (gh api, find by name, PUT or POST, `--input .github/rulesets/main.json`).
   - Expected: `task check:full` is green locally, and the guard fails on a bad BASE.
2. **Ruleset JSON** (depends on 1): add `.github/rulesets/main.json` per Decisions. Expected: valid JSON. Do not apply it yet.
3. **Workflow** (independent of 2):
   - Add `.github/workflows/ci.yml` with the triggers, concurrency, permissions, `env: UV_LOCKED: "1"`, `timeout-minutes: 15`, and SHA-pinned checkout (`fetch-depth: 0`), mise-action (pinned `version`).
   - Steps: `task setup`, then `task check:full`.
   - Expected: actionlint is clean.
4. **Docs** (depends on 1–3):
   - Update the README command list and its `check:full` description: add `task fallow` and `task security:history`, the `git fetch origin` note, a "CI runs exactly `task setup` and `task check:full`" line, and the flaky-test policy.
   - Add the learning note `docs/learning/SENTRA-25-ci-quality-gate.md`.
5. **PR and verification** (after user instruction to push/open a PR): verification steps 2–6.
6. **Enforce** (after merge, with explicit user approval): verification step 7. Then update the spec's Status and mark the Assumed items Verified or corrected.

A single PR is enough (size M). The ruleset apply is an operational step after merge, not a second PR.

## Definition of done

- The Acceptance criteria above are met, and the verification evidence (run links, durations, red-PR links) is in the PR description.
- `task check:full` and `task fallow` are green, and every fallow finding is fixed, not suppressed.
- The README and learning note are updated, and the spec's Assumed items are resolved or carried forward explicitly.
- PR uses `.github/pull_request_template.md` and links http://localhost:8080/issue/SENTRA-25 and this spec.

## Open questions and assumptions to validate

- **Assumed**: the GitHub Actions app `integration_id` is 15368. Validate after the first run with `gh api repos/boktavec/sentra/commits/<sha>/check-runs --jq '.check_runs[].app.id'` before applying the ruleset.
- **Assumed**: the check-run name equals the job id `check`, and it does not depend on the workflow name. Validate from the same API call.
- **Confirmed by user**:
  - `strict_required_status_checks_policy: true` (the branch must be up to date with main).
  - 0 required approvals.
  - No bypass actors, including the admin.
- **Assumed**: `actions/checkout` with `fetch-depth: 0` provides `refs/remotes/origin/main` on `pull_request` runs. The fail-closed guard makes a wrong assumption visible. Validate on the first run.
- **Assumed**: Linux runners install Python 3.14.8 and fallow 3.32.0 through mise without extra system packages. Validate on the first run.
- **Decision at implementation**: the `actions/cache` step was not added, because the saving cannot be measured before the first CI run. mise-action's tool cache is used. Add the cache later only if measured runs show a saving of 30 s or more.
- **Follow-up (not in scope, user confirmed)**: pre-commit hygiene hooks (trailing whitespace, EOF newline, large files, private keys) are not run in CI. `git diff --check HEAD` in `lint`/`format:check` only sees uncommitted changes, so it is a no-op on a clean CI checkout. Should a follow-up story add `pre-commit run --from-ref origin/main --to-ref HEAD` to `check:full`?
- **Follow-up (not in scope, user confirmed)**: CODEOWNERS for `.github/`, to mitigate PRs that weaken the workflow. Candidate future story.
- Local note (not a CI issue): on the planning machine, `fnm` puts Node 24.16.0 ahead of mise's 24.21.0 on PATH. CI uses mise's Node only.
