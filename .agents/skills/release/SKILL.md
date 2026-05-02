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

If releasing multiple packages, identify workspace dependencies and plan to publish
dependencies first. For example, publish `@dynobox/sdk` before `dynobox`.

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

Update `CHANGELOG.md`:

- Move the package's `[Unreleased]` entries into a new release section.
- Use `## <package-name>@<version> — YYYY-MM-DD`.
- Place the new section immediately below the `---` separator after `[Unreleased]`.

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

## Dry run mode

If the user says "dry run", "what would happen", or asks to verify publish
contents without publishing, do not run `pnpm publish`.

Build a tarball instead:

```bash
pnpm --filter <package-name> pack
tar tf packages/<dir>/*.tgz
```

Show the tarball contents and summarize whether only intended files are included.
Do not create release tags or push in dry-run mode unless the user explicitly asks.

## After publishing

Verify each published package:

```bash
npm view <package-name>@<version>
```

Then report:

- The package and version published.
- The git tag created.
- The npm URL, e.g. `https://www.npmjs.com/package/dynobox/v/0.0.4`.
- Any skipped step and why.
