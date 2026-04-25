# @dynobox/sdk

TypeScript SDK for authoring Dynobox scenario configs.

This package provides the Milestone 1 authoring contract, helper functions, config module resolver, and canonical IR compiler used by the CLI and local runner scaffold.

- Site: [dynobox.dev](https://dynobox.dev)
- GitHub: [github.com/dynobox/dynobox](https://github.com/dynobox/dynobox)

## Current exports

- `defineConfig(config)`
- `defineScenario(scenario)`
- `compile(config)`
- `resolveConfigModule(moduleExport)`
- `http.endpoint()`
- `http.called()`
- `http.notCalled()`
- IR schemas and derived IR types

## Config contract

- user config file name: `dynobox.config.ts`
- config module shape: default export
- authoring import path: `@dynobox/sdk`

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
