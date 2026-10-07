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

## MCP Tools

These MCP servers are configured for the user's local Codex, Claude Code, and Pi agents. Check that a server is connected before relying on it; tool names and availability can vary by client.

- **`youtrack`** is the source of truth for Sentra projects, boards, and user stories. Read the story and its links before planning; after the spec is agreed, use it to create or update story details, acceptance criteria, dependencies, and status. Search before creating an issue to avoid duplicates. Delete projects, boards, or stories only when the user explicitly requests deletion.
- **`context7`** provides current third-party library and framework documentation. Use it when a spec or implementation depends on a version-specific API, configuration, or integration behavior. Record the library version and relevant finding in the spec or PR. Sentra's repository and agreed spec remain the authority for Sentra requirements and decisions.

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

## Pull Requests

When creating a PR, always use `.github/pull_request_template.md` and complete all applicable sections.

PRs should clearly include:

- summary of what was built
- link to the related user story or issue
- context for why the feature is needed
- why the implementation was designed this way
- meaningful alternatives and tradeoffs
- manual testing steps and expected results
- unit test coverage
- regression test coverage
- important edge cases, including any not yet handled

For UI changes, manually verify the feature in the browser and use Playwright to capture relevant screenshots.

Do not replace manual testing instructions with automated test results.

Mark sections `N/A` only when they genuinely do not apply.

## Definition of Done

Before completing meaningful work:

- run relevant formatting, linting, type checking, and tests
- verify expected behavior and regressions
- consider security, tenant isolation, failure modes, and scalability
- update relevant documentation
- add the feature learning note when appropriate
- complete the PR template when opening a pull request

Use the repo's canonical `Task` commands whenever available.

Stay within scope. Document future improvements instead of implementing unrelated complexity.
