# Releasing Dynobox packages

## Prerequisites

- Clean working tree on `main` (no uncommitted changes).
- All tests pass: `pnpm test` from the repo root.
- You are logged in to npm: `npm whoami` should return the publishing account.
- If releasing a package that depends on another workspace package being released in this batch, release the dependency first.

## Tag convention

This monorepo uses per-package git tags: `<npm-package-name>@<version>`.

Examples:
- `dynobox@0.0.4`
- `@dynobox/sdk@0.0.2`

Do **not** use bare `v0.0.4` tags — they imply a single repo-wide version.

## Release steps

For each package being released:

1. **Verify tests pass**
   ```bash
   pnpm test
   ```

2. **Bump the version** in the package's `package.json`.
   - Use `pnpm --filter <package-name> exec npm version <patch|minor|major> --no-git-tag-version` to bump without creating a tag (we tag manually with the scoped name).

3. **Update CHANGELOG.md**
   - Move entries from the `[Unreleased]` section for this package into a new version section.
   - Use the format: `## <package-name>@<version> — YYYY-MM-DD`
   - Add the new section immediately below the `---` separator after `[Unreleased]`.

4. **Commit**
   ```bash
   git add -A
   git commit -m "chore(release): <package-name>@<version>"
   ```

5. **Tag**
   ```bash
   git tag <package-name>@<version>
   ```

6. **Push**
   ```bash
   git push && git push --tags
   ```

7. **Publish**
   ```bash
   pnpm --filter <package-name> publish --access public --no-git-checks
   ```
   `--no-git-checks` is needed because pnpm's workspace protocol resolution happens during pack, and the working tree may show the rewritten `package.json` as dirty.

8. **Verify**
   ```bash
   npm view <package-name>@<version>
   ```

## Releasing multiple packages

When releasing packages that depend on each other (e.g. `@dynobox/sdk` then `dynobox`):

1. Bump all versions first.
2. Update CHANGELOG entries for all packages.
3. Make a single commit: `chore(release): dynobox@X.Y.Z, @dynobox/sdk@A.B.C`
4. Create one tag per package.
5. Push once.
6. Publish in dependency order: SDK first, then CLI.

## Releasing @dynobox/run-schema

`@dynobox/run-schema` is published to GitHub Packages, not the public npm
registry. Its `package.json` owns the registry and access settings via
`publishConfig`:

```json
{
  "registry": "https://npm.pkg.github.com",
  "access": "restricted"
}
```

Prerequisites:

- Clean working tree on `main`, unless intentionally releasing from another
  branch.
- All tests pass: `pnpm test` from the repo root.
- Authenticated to GitHub Packages with a token that has `write:packages`:
  `npm whoami --registry=https://npm.pkg.github.com`.

Release steps:

1. **Bump the version** without creating an automatic git tag:
   ```bash
   pnpm --filter @dynobox/run-schema exec npm version <patch|minor|major> --no-git-tag-version
   pnpm --filter @dynobox/run-schema exec node -p "require('./package.json').version"
   ```

2. **Update CHANGELOG.md**
   - Move entries from the `[Unreleased]` section for `@dynobox/run-schema`
     into a new version section.
   - Use the format: `## @dynobox/run-schema@<version> — YYYY-MM-DD`.

3. **Build and inspect the package**
   ```bash
   pnpm --filter @dynobox/run-schema build
   pnpm --filter @dynobox/run-schema pack --pack-destination /tmp
   tar tf /tmp/dynobox-run-schema-<version>.tgz
   tar -xOf /tmp/dynobox-run-schema-<version>.tgz package/package.json
   ```

4. **Commit**
   ```bash
   git add packages/run-schema/package.json CHANGELOG.md
   git commit -m "chore(release): @dynobox/run-schema@<version>"
   ```

5. **Tag** using the package-specific tag convention:
   ```bash
   git tag @dynobox/run-schema@<version>
   ```

6. **Push**
   ```bash
   git push && git push --tags
   ```

7. **Publish** to GitHub Packages. Do not pass `--access public`.
   ```bash
   pnpm --filter @dynobox/run-schema publish --no-git-checks
   ```

8. **Verify**
   ```bash
   npm view @dynobox/run-schema@<version> --registry=https://npm.pkg.github.com
   ```

Do not commit `packages/run-schema/dist`; it is built locally and included in
the package tarball via the package's `files` list.

## Dry-run

To verify what will be published without actually publishing:

```bash
pnpm --filter <package-name> pack
tar tf packages/<dir>/*.tgz
```

Inspect the tarball contents to confirm only intended files are included.
