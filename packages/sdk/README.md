# @dynobox/sdk

TypeScript SDK for authoring Dynobox scenario configs.

This package provides the Milestone 1 authoring contract, helper functions, config module resolver, and canonical IR compiler used by the CLI and local runner scaffold.

- Site: [dynobox.xyz](https://dynobox.xyz)
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
- `command.called()`, `command.notCalled()`
- `anyOf()`
- `skill.referenced()`
- `artifact.exists()`, `artifact.contains()`
- `transcript.contains()`
- `finalMessage.contains()`
- `sequence.inOrder()`
- `verify.succeeds()`, `verify.command()`
- `dyno` helpers

`defineDyno(...)` also applies authoring defaults for JavaScript and
TypeScript dynos: adjacent `fixtures/` directories are attached to scenarios
that do not set `fixtures`, and dynos authored under `.agents/skills/<name>/`
or `.claude/skills/<name>/` get setup commands that copy that skill's
`SKILL.md` into the scenario work directory.

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
- file-oriented tool assertions can match paths with
  `tool.called('read_file', {path: 'package.json'})` or the equivalent
  `{type: tool.called, tool: read_file, path: package.json}` object shape
