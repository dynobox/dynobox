# Dynobox

Cross-harness testing for multi-step agent flows.

**Status:** Under active development. Not yet ready for external use.

Dynobox runs your agent flows across multiple harnesses (Claude Code, Codex, and more) in disposable sandboxed environments, captures what actually happens, and produces a pass-rate matrix so you can see when model updates or harness differences break your flows.

## Project site

[dynobox.dev](https://dynobox.dev)

## Packages

This repository is a monorepo. Published packages live under `packages/`.

| Package                                            | npm                                                | Description                                            |
| -------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------ |
| [`dynobox`](./packages/cli)                        | [`dynobox`](https://www.npmjs.com/package/dynobox) | CLI for loading configs and running local scenarios    |
| [`@dynobox/sdk`](./packages/sdk)                   | [`@dynobox/sdk`](https://www.npmjs.com/package/@dynobox/sdk) | SDK for authoring configs and compiling canonical IR   |
| [`@dynobox/runner-local`](./packages/runner-local) | Unpublished                                        | Local runner for harness execution and tool assertions |

`@dynobox/runner-local` and `@dynobox/evaluators` are private workspace packages. They stay separate so the same runtime code can be reused by future hosted runners, but they are bundled into the published `dynobox` CLI instead of exposed as public npm dependencies.

## Current Capabilities

- Author configs with `@dynobox/sdk` helpers.
- Compile configs into canonical Dynobox IR.
- Run `dynobox run <config>` to execute local jobs through Claude Code.
- Assert observed harness tool usage with `tool.called(...)`.
- Use `examples/local-observability` as the fastest local runner smoke test.

HTTP capture, HTTP assertion evaluation, and matrix rendering are still in progress.

## Status

This repository is currently read-only. Issues and pull requests are not being accepted while the project is in early development. Follow [dynobox.dev](https://dynobox.dev) for updates.

## License

Apache-2.0 for all code in this repository. See [LICENSE](./LICENSE).
