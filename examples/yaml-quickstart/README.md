# YAML Quickstart Example

A variation of the `local-observability` scenario, authored in YAML instead of
TypeScript. Use this layout when you prefer declarative config without SDK
imports. Running Dynobox still requires Node.js 22 or later.

## Run

```bash
npx dynobox run examples/yaml-quickstart
```

From a development checkout, build the CLI and run the compiled entrypoint:

```bash
pnpm --filter dynobox... build
node packages/cli/dist/bin.js run examples/yaml-quickstart
```

## YAML Schema

Each assertion is a plain object discriminated by `type`. The full
mapping from the TypeScript helper API to YAML keys is in
[`docs/config-authoring.md`](../../docs/config-authoring.md).

Examples used in this file:

```yaml
- type: command.called
  executable: cat
  command:
    args:
      - package.json
- type: artifact.contains
  path: package.json
  text: vitest run
```

## Why YAML

- No JavaScript module or SDK import to maintain.
- Easier to diff in code review when you only want to tweak setup or
  prompts.
- Compiles through the same Zod schema and IR as the TypeScript form, so
  the runtime behavior is identical.
