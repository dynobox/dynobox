# Project Rules

## Agent Behavior

- when proposing changes only suggest one file at a time for review
- tests should be colocated with the file they are testing
- always use package manager install scripts when adding or updating packages; do not manually edit dependency versions in package manifests
- examples are user-facing only; do not use files in `examples/` as test fixtures or production code inputs
- when suggesting git commit messages, prefer Conventional Commit style with a scope when appropriate, for example `chore(cli): convert placeholder package to TypeScript`
