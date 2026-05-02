---
name: release
description: |
  Publish dynobox packages to npm. Use this skill whenever the user asks to
  release, publish, ship, bump, or cut a version of any dynobox package —
  including dry runs, version bumps, changelog updates, and git tagging.
  Also trigger when the user asks about the release process or wants to
  verify publish readiness.
---

# Release

This skill executes the dynobox release procedure documented in `RELEASES.md`.
Read `RELEASES.md` before making release changes. If this skill and
`RELEASES.md` disagree, follow `RELEASES.md`.

## Before you start

Verify the repository is ready:

```bash
git status --short
git branch --show-current
pnpm test
npm whoami
```

Continue only when:

- `git status --short` is empty.
- The current branch is `main`, unless the user explicitly approves another branch.
- `pnpm test` passes.
- `npm whoami` returns the publishing account.

Abort and report the blocker if the working tree is dirty, tests fail, or npm auth
is unavailable.

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

If releasing multiple packages, identify workspace dependencies and plan to publish
dependencies first. For example, publish `@dynobox/sdk` before `dynobox`.

Before publishing `dynobox`, verify the `@dynobox/sdk` version it depends on is
already published:

```bash
npm view @dynobox/sdk@<version> version
```

If the user did not specify a version or bump type, ask whether to use `patch`,
`minor`, or `major`. Do not guess.

## Execute the release

For each package, bump without creating an automatic git tag:

```bash
pnpm --filter <package-name> exec npm version <patch|minor|major> --no-git-tag-version
```

Read the new version:

```bash
pnpm --filter <package-name> exec node -p "require('./package.json').version"
```

Confirm the package and new version with the user before committing.

When releasing `dynobox`, update the hardcoded CLI display version in
`packages/cli/src/index.ts`:

```ts
const CLI_VERSION = '<version>';
```

Search for stale references to the previous version before committing:

```bash
rg '<previous-version>' packages/cli/src packages/cli/package.json CHANGELOG.md
```

Update `CHANGELOG.md`:

- Move the package's `[Unreleased]` entries into a new release section.
- Use `## <package-name>@<version> — YYYY-MM-DD`.
- Place the new section immediately below the `---` separator after `[Unreleased]`.

Run the pre-publish verification below before committing, tagging, or publishing.

Commit and tag after the user confirms:

```bash
git add -A
git commit -m "chore(release): <package-name>@<version>"
git tag <package-name>@<version>
git push && git push --tags
```

Publish the package:

```bash
pnpm --filter <package-name> publish --access public --no-git-checks
```

Use `--no-git-checks` because pnpm may rewrite workspace protocol versions while
packing, which can make the working tree appear dirty during publish.

## Multi-package releases

When releasing packages that depend on each other:

1. Run the preflight checks once.
2. Bump all package versions first.
3. Update `CHANGELOG.md` for all packages.
4. Confirm all new versions with the user before committing.
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
8. Publish in dependency order:
   ```bash
   pnpm --filter @dynobox/sdk publish --access public --no-git-checks
   pnpm --filter dynobox publish --access public --no-git-checks
   ```

## Pre-publish verification

After version and changelog updates, but before committing, tagging, or
publishing, inspect the package tarball:

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

The packed `dynobox` dependencies should include `@dynobox/sdk`, `commander`,
`execa`, and `tsx`, but not `@dynobox/runner-local` or `@dynobox/evaluators`.

Optionally smoke-test local tarballs before publishing:

```bash
tmpdir="$(mktemp -d)"
npm install --prefix "$tmpdir" /tmp/dynobox-sdk-<sdk-version>.tgz /tmp/dynobox-<cli-version>.tgz
"$tmpdir/node_modules/.bin/dynobox"
```

## Dry run mode

If the user says "dry run", "what would happen", or asks to verify publish
contents without publishing, do not run `pnpm publish`.

Build a tarball instead:

```bash
pnpm --filter <package-name> pack --pack-destination /tmp
tar tf /tmp/<tarball-name>.tgz
```

Show the tarball contents and summarize whether only intended files are included.
Do not create release tags or push in dry-run mode unless the user explicitly asks.

## After publishing

Verify each published package:

```bash
npm view <package-name>@<version>
```

If `npm view` briefly returns a stale `404` for a newly published scoped package,
cross-check npm access and the registry document before treating the publish as
failed:

```bash
npm access get status <package-name>
```

For scoped packages, the registry document URL uses an encoded slash, for example:

```text
https://registry.npmjs.org/@dynobox%2fsdk
```

If `pnpm publish` fails with `EOTP`, do not re-bump, re-commit, re-tag, or ask
the user for an OTP. Stop and present the final publish commands for the user to
run locally, in dependency order, without an `--otp` argument. For example:

```bash
pnpm --filter @dynobox/sdk publish --access public --no-git-checks
pnpm --filter dynobox publish --access public --no-git-checks
```

Tell the user to run only the commands for packages that have not already been
published, and then verify with `npm view`.

Then report:

- The package and version published.
- The git tag created.
- The npm URL, e.g. `https://www.npmjs.com/package/dynobox/v/0.0.4`.
- Any skipped step and why.
