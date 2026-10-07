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

Use project skills for detailed coding, testing, debugging, security, and review practices.

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
