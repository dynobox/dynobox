# Project Rules

## Agent Behavior

- when proposing changes only suggest one file at a time for review
- tests should be colocated with the file they are testing
- always use package manager install scripts when adding or updating packages; do not manually edit dependency versions in package manifests
- package scripts should only build, typecheck, and test their own package; do not call another workspace package's scripts from inside a package script
- use pnpm's workspace graph from the caller/root for dependency ordering, e.g. `pnpm build` for the repo or `pnpm --filter <package>... build` for a package plus its dependencies
- examples are user-facing only; do not use files in `examples/` as test fixtures or production code inputs
- when suggesting git commit messages, prefer Conventional Commit style with a scope when appropriate, for example `chore(cli): convert placeholder package to TypeScript`

## Releases

- Follow the procedure in `RELEASES.md` for all npm publishes.
- Git tags use the per-package convention: `<npm-package-name>@<version>` (e.g. `dynobox@0.0.4`).
- Changelog entries go in the root `CHANGELOG.md`, grouped under the package name.
- Never use bare `vX.Y.Z` tags.
