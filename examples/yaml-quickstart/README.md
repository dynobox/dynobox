# YAML Quickstart Example

The same scenario as `local-observability`, authored in YAML instead of
TypeScript. Use this layout when you'd rather not pull in a Node
toolchain to author tests.

## Run

```bash
node packages/cli/dist/bin.js run examples/yaml-quickstart
```

Or with the published CLI:

```bash
dynobox run examples/yaml-quickstart
```

## YAML Schema

Each assertion is a plain object discriminated by `type`. The full
mapping from the TypeScript helper API to YAML keys is in
[`docs/config-authoring.md`](../../docs/config-authoring.md).

Examples used in this file:

```yaml
- type: tool.called
  tool: shell
- type: tool.called
  tool: shell
  command:
    includes: package.json
- type: artifact.contains
  path: package.json
  text: vitest run
```

## Why YAML

- Lower friction for skill or prompt authors who don't run Node locally.
- Easier to diff in code review when you only want to tweak setup or
  prompts.
- Compiles through the same Zod schema and IR as the TypeScript form, so
  the runtime behavior is identical.
