---
name: Bug report
about: Report something that broke or behaves wrongly (crash, wrong rendering, failed import / save / export)
title: '[Bug] '
labels: bug
assignees: ''
---

## Problem
Describe what happened in one sentence.

## Environment
Complete this section with the version, interface language, and operating system used when the problem occurred.

- Leaf version or commit:
- Interface language:
- Operating system:

## Steps to reproduce
1.
2.
3.

## Expected result
What should have happened?

## Actual result
What actually happened?

## Impact
For example: import, save, or export failed; incorrect data; difficult-to-use interface.

## Evidence
Attach redacted screenshots or logs if helpful.
Do not upload real audio, real transcripts, passwords, API keys, credentials, or screenshots containing private paths.

## Delivery progress (maintainer fills in)

Keep feature acceptance criteria separate from delivery progress. Check an item only when supported by evidence. Installed-app acceptance requires explicit user confirmation; automated tests, browser checks, and packages do not replace it. macOS results do not establish Windows acceptance.

- [ ] Code changes completed
- [ ] Automated tests / applicable browser regressions passed
- [ ] macOS installed-app acceptance passed
- [ ] Windows installed-app acceptance passed
- [ ] Merged into `main`

### Verification record

- Automated / browser checks: commit, scope, results; explain any checks that do not apply.
- macOS installed app: version / build, Chinese and English coverage, user confirmation; mark unchecked coverage as pending.
- Windows installed app: version / build, Chinese and English coverage, user confirmation; keep deferred acceptance unchecked and name the follow-up plan.
- Merge: linked PR and actual merge commit.

For single-platform or documentation-only work, retain the platform items and record “not applicable” with a reason rather than checking them as passed. Closing an issue does not establish Windows acceptance.
