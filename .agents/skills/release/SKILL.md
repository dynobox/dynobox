---
name: release
description: |
  Prepare dynobox packages for release to npm. Use this skill whenever the user
  asks to release, publish, ship, bump, or cut a version of any dynobox package —
  including dry runs, version bumps, changelog updates, and git tagging.
  Also trigger when the user asks about the release process or wants to
  verify publish readiness.
---

# Release

This skill prepares dynobox packages for release. It handles everything up to
but not including `npm publish` — tests, version bumps, changelog updates,
tarball inspection, committing, and tagging. At the end it presents the publish
commands for the user to run manually.

Read `RELEASES.md` before making release changes. If this skill and
`RELEASES.md` disagree, follow `RELEASES.md`.

## Before you start

Verify the repository is ready:

```bash
git status --short
git branch --show-current
pnpm test
```

Continue only when:

- `git status --short` is empty.
- The current branch is `main`, unless the user explicitly approves another branch.
- `pnpm test` passes.

Abort and report the blocker if the working tree is dirty or tests fail.

## Determine what to release

Identify the package name, package directory, and requested bump:

```bash
pnpm --filter <package-name> exec node -p "require('./package.json').version"
```

Use these package names for public releases:

- `dynobox` for `packages/cli`
- `@dynobox/sdk` for `packages/sdk`

Current package policy:

- Publish `dynobox` and `@dynobox/sdk` to npm.
- Keep `@dynobox/runner-local` and `@dynobox/evaluators` private.
- The `dynobox` CLI bundles private runtime workspace packages instead of
  exposing them as public npm dependencies.

If releasing multiple packages, identify workspace dependencies and plan to
publish dependencies first. For example, publish `@dynobox/sdk` before `dynobox`.

If the user did not specify a version or bump type, ask whether to use `patch`,
`minor`, or `major`. Do not guess.

## Bump the version

For each package, bump without creating an automatic git tag:

```bash
pnpm --filter <package-name> exec npm version <patch|minor|major> --no-git-tag-version
```

Read the new version:

```bash
pnpm --filter <package-name> exec node -p "require('./package.json').version"
```

When releasing `dynobox`, update the hardcoded CLI display version in
`packages/cli/src/index.ts`:

```ts
const CLI_VERSION = '<version>';
```

Search for stale references to the previous version before committing:

```bash
rg '<previous-version>' packages/cli/src packages/cli/package.json CHANGELOG.md
```

## Update CHANGELOG.md

- Move the package's `[Unreleased]` entries into a new release section.
- Use `## <package-name>@<version> — YYYY-MM-DD`.
- Place the new section immediately below the `[Unreleased]` heading.

## Inspect the tarball

After version and changelog updates, inspect the package tarball:

```bash
pnpm --filter <package-name> pack --pack-destination /tmp
tar tf /tmp/<tarball-name>.tgz
tar -xOf /tmp/<tarball-name>.tgz package/package.json
```

For `dynobox`, confirm the packed `package.json` runtime dependencies include
only public npm packages. It must not include private workspace packages:

```bash
rg '@dynobox/(runner-local|evaluators)' packages/cli/dist
```

Expected result: no matches.

## Dry run mode

If the user says "dry run", "what would happen", or asks to verify publish
contents without actually releasing:

1. Run tests.
2. Bump the version.
3. Update the changelog.
4. Inspect the tarball.
5. Report what the tarball contains and whether it looks correct.

Do **not** commit, tag, or push in dry-run mode. Do not present publish commands.

## Commit, tag, and push (non-dry-run only)

Commit and tag after verifying the tarball:

```bash
git add -A
git commit -m "chore(release): <package-name>@<version>"
git tag <package-name>@<version>
git push && git push --tags
```

## Present publish commands

After all preparation is complete, present the publish commands for the user to
run manually. Never run these commands yourself.

For a single package:

```bash
pnpm --filter <package-name> publish --access public --no-git-checks
```

For multiple packages, present them in dependency order:

```bash
pnpm --filter @dynobox/sdk publish --access public --no-git-checks
pnpm --filter dynobox publish --access public --no-git-checks
```

Then tell the user to verify after publishing:

```bash
npm view <package-name>@<version>
```

## Multi-package releases

When releasing packages that depend on each other:

1. Run the preflight checks once.
2. Bump all package versions first.
3. Update `CHANGELOG.md` for all packages.
4. Inspect tarballs for all packages.
5. Make one release commit:
   ```bash
   git add -A
   git commit -m "chore(release): dynobox@X.Y.Z, @dynobox/sdk@A.B.C"
   ```
6. Create one tag per package:
   ```bash
   git tag @dynobox/sdk@A.B.C
   git tag dynobox@X.Y.Z
   ```
7. Push once:
   ```bash
   git push && git push --tags
   ```
8. Present publish commands in dependency order.
