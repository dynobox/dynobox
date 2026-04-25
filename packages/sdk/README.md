# @dynobox/sdk

TypeScript SDK for authoring Dynobox scenario configs.

This package is an early scaffold for Milestone 1. It currently provides the initial config contract and placeholder exports that the CLI will build on next.

- Site: [dynobox.dev](https://dynobox.dev)
- GitHub: [github.com/dynobox/dynobox](https://github.com/dynobox/dynobox)

## Current exports

- `defineConfig(config)`
- `compile(config)`
- `resolveConfigModule(moduleExport)`
- `http.endpoint()` placeholder
- `http.called()` placeholder
- `http.notCalled()` placeholder

## Config contract

- user config file name: `dynobox.config.ts`
- config module shape: default export
- authoring import path: `@dynobox/sdk`

## Local development

Run from the repository root:

```bash
pnpm --filter @dynobox/sdk test
pnpm --filter @dynobox/sdk typecheck
pnpm --filter @dynobox/sdk build
```

Run from `packages/sdk`:

```bash
pnpm test
pnpm typecheck
pnpm build
```
