# Dynobox

Cross-harness testing for multi-step agent flows.

**Status:** Under active development. Not yet ready for external use.

Dynobox runs your agent flows across multiple harnesses (Claude Code, Codex, and more) in disposable sandboxed environments, captures what actually happens, and produces a pass-rate matrix so you can see when model updates or harness differences break your flows.

## Project site

[dynobox.dev](https://dynobox.dev)

## Packages

This repository is a monorepo. Published packages live under `packages/`.

| Package | npm | Description |
|---|---|---|
| [`dynobox`](./packages/cli) | [`dynobox`](https://www.npmjs.com/package/dynobox) | CLI for authoring and running scenarios |

## Status

This repository is currently read-only. Issues and pull requests are not being accepted while the project is in early development. Follow [dynobox.dev](https://dynobox.dev) for updates.

## License

Apache-2.0 for all code in this repository. See [LICENSE](./LICENSE).
