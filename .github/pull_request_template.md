# Summary

<!-- Briefly explain what this PR adds, changes, or fixes. -->

## User Story

<!-- Link the YouTrack story by URL (not just its ID), then any spec, ADR, and learning note. Use commit-SHA permalinks or the default-branch path, not the feature branch. -->

Story: <YouTrack story URL>

Spec / ADR / learning note:

## Context

<!-- Why is this being built? What problem or requirement does it address? -->

## Implementation

<!-- Explain the main implementation approach. Focus on architecture and important decisions, not a file-by-file walkthrough. -->

### Why this approach?

<!-- Why was this solution chosen? Mention meaningful alternatives considered and the tradeoffs made. -->

## Screenshots

<!--
Required for UI changes.

Use Playwright to capture screenshots of the implemented UI where practical.
Include relevant states such as desktop/mobile, success/error, or before/after when useful.

Commit the images under docs/features/<issue-id>-<slug>/screenshots/ and link them with absolute
commit-SHA permalinks (https://github.com/<owner>/<repo>/blob/<sha>/<path>?raw=true) so they
survive branch deletion.

Delete this section for non-UI changes.
-->

| Before | After          |
| ------ | -------------- |
| N/A    | Add screenshot |

## Manual Testing

<!--
Provide clear steps a reviewer can follow to verify the feature manually.
Do not substitute unit tests for manual verification.
-->

1.
2.
3.

### Expected Result

<!-- What should the reviewer observe if the feature is working correctly? -->

## Automated Tests

### Unit Tests

<!-- What behavior is covered by unit tests? -->

-

### Regression Tests

<!-- What previously working behavior is explicitly protected from regression? -->

-

## Edge Cases

<!--
List important edge cases and failure scenarios.

Clearly identify anything known but NOT currently handled.
Do not claim "none" without considering failure modes, tenant boundaries, invalid input, retries, concurrency, and scale where relevant.
-->

### Covered

-

### Not Yet Covered / Follow-up

-

## New Dependencies

<!-- List each new dependency, service, or datastore and why it is needed. Write N/A if none. -->

-

## Running Locally

<!-- Commands to start the stack and run the feature (Task commands, ports, setup). Note which test suites need the stack and whether CI runs them. -->

## Additional Notes

<!-- Optional: migrations, deployment considerations, compatibility concerns, observability, security implications, follow-up work, etc. -->
