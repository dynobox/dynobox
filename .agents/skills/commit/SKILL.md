---
name: commit
description: |
  Prepare and create git commits for dynobox. Use this skill whenever the user
  asks to commit, create a commit, suggest a commit message, stage changes, or
  prepare changes for review. Also use it when the user asks whether the
  changelog should be updated before committing.
---

# Commit

This skill prepares safe, focused git commits using the repository's
Conventional Commit style.

If the requested commit is for an npm publish, version bump, git tag, release
changelog entry, or publish readiness workflow, use the `release` skill instead.

## Before you start

Inspect the repository state:

```bash
git status --short
git diff
git diff --staged
git log -5 --oneline
```

Do not commit unless the user explicitly asked to commit. If the user only asked
for a message suggestion or review, do not stage or commit files.

Never amend a commit unless the user explicitly asks. Never push unless the user
explicitly asks.

## Inspect changes

Identify which files belong to the requested commit and which files may be
unrelated user work.

Before staging, check for likely secrets or accidental artifacts:

- `.env` files
- credentials, tokens, keys, or npm auth files
- debug logs or npm error logs
- generated tarballs or temporary archives
- unrelated build outputs

If the working tree contains unrelated changes, stage only the relevant files
with explicit paths. Do not use `git add -A` unless all changed files clearly
belong to the requested commit.

## Changelog decision

Update `CHANGELOG.md` only when the change is user-facing or release-relevant.

Usually update the changelog for:

- New user-facing CLI behavior
- SDK authoring API changes
- Bug fixes users would notice
- Packaging changes that affect installs or publishes

Usually do not update the changelog for:

- Tests only
- Internal refactors
- Lint or formatting only
- Documentation-only changes
- WIP changes that are not ready to announce

If unsure, ask whether the change should be added to `[Unreleased]`. For release
version sections, use the `release` skill instead.

## Verification

Run verification that matches the change scope before committing when practical:

```bash
pnpm test
```

For package-specific changes, prefer scoped verification where appropriate:

```bash
pnpm --filter <package-name> test
pnpm --filter <package-name> typecheck
```

If verification is skipped, include the reason in the final response.

## Commit message

Use Conventional Commit style with a scope when appropriate:

```text
<type>(<scope>): <summary>
```

Common types:

- `feat` for new behavior
- `fix` for bug fixes
- `docs` for documentation-only changes
- `test` for tests-only changes
- `refactor` for behavior-preserving code changes
- `chore` for repository maintenance

Common scopes in this repo:

- `cli`
- `sdk`
- `runner-local`
- `evaluators`
- `release`
- `docs`

Examples:

```bash
git commit -m "fix(cli): bundle private runtime packages"
git commit -m "docs(release): document npm publish process"
git commit -m "test(cli): cover config loading failures"
```

Prefer a concise message that explains why the change exists, not a mechanical
list of edited files.

## Stage and commit

Stage relevant files explicitly:

```bash
git add <file> <file>
```

Commit with the selected message:

```bash
git commit -m "<message>"
```

If hooks or formatting modify files, inspect the result with `git status --short`
and create a new commit attempt after staging the hook changes. Do not amend
unless the user explicitly asked for an amend.

## After commit

Verify the commit succeeded:

```bash
git status --short
git log -1 --oneline
```

Report:

- The commit hash and message.
- Any verification run.
- Any files intentionally left uncommitted.
- Whether the branch was pushed, only if the user asked for a push.
