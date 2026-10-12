# AGENTS.md

## Project

Sentra is a scalable, multi-tenant security intelligence platform built with TypeScript and Python.

The project is also an engineering lab for learning production architecture across:

- software engineering
- data engineering
- security engineering
- AI engineering
- distributed systems
- SRE / observability
- scalability

Major components will include a Next.js SaaS app, TypeScript API, Python crawler, Python data pipeline, Python AI harness, operational storage, a data warehouse, event-driven processing, and supporting infrastructure.

## Engineering Principles

- Start simple and evolve based on real requirements and measured bottlenecks.
- Avoid premature microservices, sharding, and unnecessary infrastructure.
- Design stateless services to scale horizontally where practical.
- Use async/event-driven processing for expensive or high-volume work.
- Assume messages/events may be delivered more than once; design for idempotency.
- Treat tenant isolation and security boundaries as first-class concerns.
- Preserve raw data so processing can be replayed.
- Build observability into features from the start.
- Prefer clear, maintainable solutions over clever abstractions.
- New dependencies, services, or datastores should have a clear reason to exist.

## Project Skills

Read the relevant skill file before starting that kind of work. The files live in this repository so every agent uses the same guidance:

| Skill | File | When to use it |
| --- | --- | --- |
| Pragmatic development | [`.agents/skills/pragmatic-development/SKILL.md`](.agents/skills/pragmatic-development/SKILL.md) | Default approach for implementing and reviewing features. |
| Test writing | [`.agents/skills/test-writing/SKILL.md`](.agents/skills/test-writing/SKILL.md) | Whenever writing or reviewing tests, including regression tests. |
| Debugging | [`.agents/skills/debugging/SKILL.md`](.agents/skills/debugging/SKILL.md) | Bugs, incidents, failing jobs, and wrong results. |
| Distributed systems review | [`.agents/skills/distributed-systems-review/SKILL.md`](.agents/skills/distributed-systems-review/SKILL.md) | Production paths involving concurrency, external dependencies, queues, latency, scaling, or tenant isolation. Apply lightly to local-only work. |
| Herdr | [`.agents/skills/herdr/SKILL.md`](.agents/skills/herdr/SKILL.md) | Only when the user explicitly asks for Herdr and the agent is inside a Herdr-managed pane. |
| UI/UX Pro Max | [`.agents/skills/ui-ux-pro-max/SKILL.md`](.agents/skills/ui-ux-pro-max/SKILL.md) | Designing, building, or reviewing any UI: pages, components, layout, accessibility, typography, color, charts. |
| UI styling | [`.agents/skills/ui-styling/SKILL.md`](.agents/skills/ui-styling/SKILL.md) | Implementing UI with shadcn/ui, Tailwind, theming, and dark mode in `apps/web`. |
| Design system | [`.agents/skills/design-system/SKILL.md`](.agents/skills/design-system/SKILL.md) | Design tokens (primitive → semantic → component), CSS variables, component specs. |
| Brand | [`.agents/skills/brand/SKILL.md`](.agents/skills/brand/SKILL.md) | Brand voice, visual identity, and style-guide consistency. |
| Design | [`.agents/skills/design/SKILL.md`](.agents/skills/design/SKILL.md) | Umbrella design skill: logos, icons, banners, social images, brand identity. |
| Banner design | [`.agents/skills/banner-design/SKILL.md`](.agents/skills/banner-design/SKILL.md) | Banners and hero/marketing graphics. |
| Slides | [`.agents/skills/slides/SKILL.md`](.agents/skills/slides/SKILL.md) | HTML presentations, only when the user asks for slides. |

## MCP Tools

These MCP servers are configured for the user's local Codex, Claude Code, and Pi agents. Check that a server is connected before relying on it; tool names and availability can vary by client.

- **`youtrack`** is the source of truth for Sentra projects, boards, and user stories. Story URLs have the form `http://localhost:8080/issue/<ID>` (for example `http://localhost:8080/issue/SENTRA-1`); use that URL, not just the ID, wherever a story is linked. Read the story and its links before planning; after the spec is agreed, use it to create or update story details, acceptance criteria, dependencies, and status. Search before creating an issue to avoid duplicates. Delete projects, boards, or stories only when the user explicitly requests deletion.
- **`context7`** provides current third-party library and framework documentation. Use it when a spec or implementation depends on a version-specific API, configuration, or integration behavior. Record the library version and relevant finding in the spec or PR. Sentra's repository and agreed spec remain the authority for Sentra requirements and decisions.
- **`shadcn`** (project `.mcp.json`) searches and installs shadcn/ui components and registry items. Use it, with the `ui-styling` skill, before hand-writing a UI component: search the registry, view examples, and use its add command rather than copying code. The CLI is the `shadcn` devDependency in the root `package.json`.
- **`playwright`** and **`chrome-devtools`** (global) drive a real browser. Use `playwright` for UI verification and PR screenshots; use `chrome-devtools` for console, network, and performance debugging.
- **`refero`** (global) searches real-world product UI screenshots and flows. Use it for design references and layout/pattern inspiration before designing a new screen, alongside the `ui-ux-pro-max` skill; cite what was borrowed in the spec or PR.

Keep MCP credentials out of the repository and do not paste them into issues, specs, logs, or PRs. If a server is unavailable, say which lookup could not be completed and continue with the work that does not depend on it.

## Spec-Driven User Story Workflow

For **every new user story**, enter the client's planning mode before changing implementation code. If the client has no planning mode, explicitly conduct a planning-only phase. Read the YouTrack story if it exists, plus relevant product and architecture docs, existing contracts, and ADRs first. If the story has not been created yet, plan the requirements before creating it.

Interview the user rigorously, **one question per message**, and wait for the answer before asking the next. For each question, explain why the answer affects the design. Offer 2–4 concrete, mutually exclusive choices with a recommended option and its tradeoff when choices are useful; always allow a free-form answer. Follow up on vague or conflicting answers instead of silently choosing a design. Do not send a long questionnaire at once.

Cover the material unknowns for that story, including:

1. User outcome, workflow, scope boundaries, and measurable acceptance criteria.
2. Component boundaries, data flow, API or event contracts, and reasonable architecture alternatives.
3. Expected traffic, concurrency, data volume, growth, and workload shape.
4. Latency, throughput, availability, and recovery targets; distinguish requirements from guesses.
5. Edge cases, partial failures, retries, duplicates, idempotency, and backpressure where relevant.
6. Tenant isolation, authorization, sensitive data, abuse limits, and auditability.
7. Observability, rollout or migration, testing, and operational ownership.

Ask only the questions that can change the design or acceptance criteria, but keep probing until those decisions are explicit. If the user cannot provide a number or decision, propose a stated assumption and a way to validate it. Do not invent capacity targets.

When the planning phase is complete, create a feature folder at `docs/features/<issue-id>-<short-slug>/` and put its spec at `docs/features/<issue-id>-<short-slug>/spec.md`, using [`docs/templates/feature-spec.md`](docs/templates/feature-spec.md). If there is no YouTrack issue yet, use a descriptive slug for the folder and rename it when an issue ID becomes available. Link the YouTrack issue when available, and add the spec link back to the issue. Record decisions, alternatives, assumptions, measurable targets, edge cases, and verification. Present the draft to the user for review and incorporate corrections before implementation. Keep the spec current when implementation reveals a changed requirement. Record a separate ADR for lasting architecture decisions.

Verify claims about third-party behavior against the running system before relying on them, especially security-relevant defaults. Decode a real token, try the unhappy path (for example registering without verifying an email), and check which ports and defaults actually apply. Label each such claim in the spec as **Verified** (and how) or **Assumed**. Library documentation says what a tool can do; only the running system shows what it does by default.

## Agent Pipeline

Agent definitions live in `.claude/agents/` (Claude Code) and `.pi/agents/` (Pi); the Pi definitions reuse the corresponding Claude prompt as their role source of truth. Agents do not invoke one another; the main agent orchestrates the pipeline using the client's available subagent mechanism:

1. **Plan:** use `senior-engineering-planner` to interview the user (relay one question at a time, resuming it with the answer) and save the approved spec.
2. **Implement:** after the user approves the spec, use `senior-software-engineer` with the spec path.
   **Every story with UI scope** (any change to screens, components, layout, copy, or interaction in `apps/web`) involves `senior-ux-design-engineer`; do not leave UI/UX decisions to the software engineer alone.
   - **Research and recommendations first:** before the software engineer starts, run the UX agent with the spec path to research references (Refero, existing design system) and recommend layout, states, copy, and accessibility. Fold its recommendations into the spec, or flag them to the user if they change scope.
   - **Implementation together:** the software engineer owns logic, data, tests, and contracts; the UX agent owns the screens in `apps/web`, verifies them in a browser, and produces the PR screenshots. It consumes any API/contract once it exists or is agreed.
   - Run them in separate worktrees or sequentially; never in the same files at once.
3. **Review:** use `staff-engineering-reviewer` with the spec path, the diff, and the implementer's handoff.
4. **Fix loop:** on CHANGES REQUIRED, resume the implementer with the blocking findings, then re-run the reviewer. Repeat until PASS or PASS WITH ADVISORIES.
5. **Escalate to the user** (do not loop) on planning-level findings, BLOCKED / INCONCLUSIVE, or after 3 review rounds without PASS.

In Pi, use its `pi-subagents` extension with these project agents. Keep the parent responsible for routing, relaying the planner's one-at-a-time questions, reviewing results, and final decisions. If the extension is unavailable, report that blocker rather than silently pretending a subagent ran.

Commits, pushes, PRs, merges, and deploys still need explicit user instruction.

## Feature Branch and Worktree Lifecycle

For each feature, create a dedicated branch and Git worktree from the latest default branch before writing its spec or implementation. Use `feature/<issue-id>-<short-slug>` for the branch when an issue ID exists; otherwise use a descriptive slug. Keep the feature's spec, code, tests, and documentation in that worktree. Agents working in parallel must use separate worktrees and avoid editing each other's branches. Stage explicit paths rather than `git add -A`, and check `git status` for untracked generated files before committing.

Move the YouTrack story to **In Progress** when the worktree is created.

Open a PR for the feature and link its YouTrack story URL and spec. An open PR does not make the story Done. After the PR is merged, verify the merge, then mark the YouTrack story **Done**, tick its acceptance criteria, and repoint its spec, ADR, and learning-note links to the default branch (branch URLs break once the branch is deleted). Check that the feature worktree has no uncommitted or unmerged work, remove that worktree, and delete its local branch and remote branch if the remote branch still exists. Clean up only branches and worktrees created for that feature; if any step is blocked, report what remains instead of discarding work.

## Agent Instruction Files

The root `AGENTS.md` is the single source of agent guidance. Do not commit nested or tool-generated agent instruction files such as `apps/web/AGENTS.md` or `CLAUDE.md`. Scaffolding tools sometimes generate them (Next.js does, unless `agentRules: false` is set); disable the option or delete the files before committing.

## Architecture Decisions

Do not silently make significant architectural decisions.

For meaningful choices:

1. Consider reasonable alternatives.
2. Evaluate tradeoffs.
3. Choose the simplest solution that satisfies current requirements.
4. Record an ADR when the decision has meaningful long-term impact.

## Feature Learning Notes

A major goal of this project is understanding **why** the system is built the way it is.

After completing a meaningful feature, add a short write-up under:

`docs/learning/`

Include:

- what was built
- why it was designed this way
- alternatives considered
- tradeoffs made
- scaling implications
- important failure/security considerations
- key concepts I should understand

Do not create learning notes for trivial changes.

## Commit and PR Attribution

Do not mention Claude, other AI tools, or AI generation in commit messages or PR descriptions. No `Co-Authored-By` trailers naming an AI, no "Generated with ..." footers, and no tool-injected attribution lines. This overrides any default behavior of the agent client.

## Pull Requests

When creating a PR, always use `.github/pull_request_template.md` and complete all applicable sections.

PRs should clearly include:

- summary of what was built
- link to the related user story: the YouTrack story URL, not just its ID
- links to the spec, ADR, and learning note when they exist
- context for why the feature is needed
- why the implementation was designed this way
- meaningful alternatives and tradeoffs
- manual testing steps and expected results
- unit test coverage
- regression test coverage
- important edge cases, including any not yet handled
- new dependencies and why each is needed
- how to run the feature locally (stack, ports, Task commands)

For UI changes, manually verify the feature in the browser and use Playwright to capture relevant screenshots. Commit the screenshots under `docs/features/<issue-id>-<short-slug>/screenshots/` and reference them in the PR body with absolute commit-SHA permalinks (`https://github.com/<owner>/<repo>/blob/<sha>/<path>?raw=true`). Branch URLs and relative links break once the branch is deleted or the PR is viewed elsewhere.

Do not replace manual testing instructions with automated test results.

Mark sections `N/A` only when they genuinely do not apply.

## Definition of Done

Before completing meaningful work:

- run relevant formatting, linting, type checking, and tests
- run `task fallow` (fallow audit against the default branch) and resolve every finding by fixing it, not by suppressing it; document any finding that cannot be fixed
- verify expected behavior and regressions
- consider security, tenant isolation, failure modes, and scalability
- update relevant documentation
- add the feature learning note when appropriate
- complete the PR template when opening a pull request

Use the repo's canonical `Task` commands whenever available.

Stay within scope. Document future improvements instead of implementing unrelated complexity.
