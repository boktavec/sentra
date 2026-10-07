---
name: test-writing
description: How to write tests - real code paths over mocks, production-shaped fixtures, end-to-end through the real entry point. Use whenever writing or reviewing tests, including regression tests during debugging and tests for new features.
---

# Write tests

## Principles
- Use real code paths: the real functions, classes and calls, real parsing/serialization, and real storage (e.g. seeded SQLite or a local test server) wherever feasible. Every mock or fake is a place where the test can diverge from production and miss a regression.
- Fake only what you cannot run locally (third-party network, payment gateways, wall-clock time). Fake at the outermost boundary, not in the middle of your own code.
- Never fake the component under test or anything between it and the behavior you assert.
- Keep fixtures production-shaped: sizes that cross page/batch boundaries, real flag values, real field names, realistic edge data. Small happy-path data is how staging misses bugs.
- If you must fake something, read the real implementation and confirm the fake behaves the same on the case being tested. Note each fake and what it leaves unverified.
- Prefer one end-to-end style test through the real entry point over several unit tests with mocked collaborators. Add a narrow unit test only for edge cases (e.g. empty input, empty page).
- Assert on business outcomes (counts, totals, final state), not on internal calls.

## Check before finishing
- Does the test fail if the behavior breaks? For a bug fix, run it against the old code and confirm it fails for the identified reason. For new code, break the logic temporarily and confirm it fails.
- Run the full suite, not just the new test.
- Match the repo's existing test framework and conventions. Don't add dependencies or frameworks.
