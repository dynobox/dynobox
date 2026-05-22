# @dynobox/sdk

TypeScript SDK for authoring Dynobox scenario configs.

This package provides the Milestone 1 authoring contract, helper functions, config module resolver, and canonical IR compiler used by the CLI and local runner scaffold.

- Site: [dynobox.dev](https://dynobox.dev)
- GitHub: [github.com/dynobox/dynobox](https://github.com/dynobox/dynobox)

## Current exports

### `@dynobox/sdk`

Authoring helpers for user config files:

- `defineDyno(config)`
- `defineScenario(scenario)`
- `http.endpoint()`
- `http.called()`
- `http.notCalled()`
- `tool.called()`, `tool.notCalled()`
- `skill.invoked()`
- `artifact.exists()`, `artifact.contains()`
- `transcript.contains()`
- `finalMessage.contains()`
- `sequence.inOrder()`
- `dyno` helpers

### `@dynobox/sdk/compiler`

Compiler and config-loader utilities used by the CLI and integrations:

- `compile(config)`
- `resolveConfigModule(moduleExport)`
- `configSchema`
- `DynoboxConfigError`

### `@dynobox/sdk/ir`

Canonical IR contract used by runners and evaluators:

- IR schemas and derived IR types

## Config contract

- discovered user config names: `*.dyno.{mjs,js,ts,mts,yaml,yml}`
- config module shape: default export for JavaScript/TypeScript, same object
  shape in YAML
- authoring import path: `@dynobox/sdk`
- assertion objects use `type` plus assertion-specific fields, matching YAML
  declarations and SDK helper return values

## Local development

Run from the repository root:

```bash
pnpm --filter @dynobox/sdk test
pnpm --filter @dynobox/sdk typecheck
pnpm --filter @dynobox/sdk... build
```

Run from `packages/sdk`:

```bash
pnpm test
pnpm typecheck
pnpm build
```
