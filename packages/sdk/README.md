# @dynobox/sdk

JavaScript and TypeScript SDK for authoring Dynobox scenario configs.

This package provides the authoring contract, helper functions, config module
resolver, and canonical IR compiler used by the CLI and local runner.

- Site: [dynobox.xyz](https://dynobox.xyz)
- GitHub: [github.com/dynobox/dynobox](https://github.com/dynobox/dynobox)

## Install

```bash
npm install --save-dev @dynobox/sdk
```

## Example

```js
import {command, defineDyno, finalMessage} from '@dynobox/sdk';

export default defineDyno({
  name: 'package-check',
  harnesses: ['claude-code'],
  scenarios: [
    {
      name: 'finds the test script',
      prompt: 'Use cat package.json and tell me whether it has a test script.',
      assertions: [
        command.called('cat', {args: ['package.json']}),
        finalMessage.contains('test'),
      ],
    },
  ],
});
```

See the [Config Authoring reference](https://docs.dynobox.xyz/config-authoring)
for setup, fixtures, harness options, YAML, and every assertion type.

## Experimental CLI Mocks

Scenario `cliMocks` can replace bare executable calls with static or ordered
responses, or a JavaScript/TypeScript handler:

```ts
cliMocks: {
  vitest: {
    response: {exitCode: 0, stdout: 'all tests passed'},
  },
}
```

CLI mocking is experimental. Its authoring and reporting contracts may change
between releases. See the [CLI Mocks reference](https://docs.dynobox.xyz/config-authoring/#cli-mocks)
for configuration, handlers, assertion behavior, and platform limits.

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
- `anyOf()` (supports nested `verify.command(...)` / `verify.succeeds(...)`)
- `skill.referenced()`
- `artifact.exists()`, `artifact.notExists()`, `artifact.contains()`,
  `artifact.unchanged()`
- `transcript.contains()`
- `finalMessage.contains()`
- `sequence.inOrder()`
- `verify.succeeds()`, `verify.command()`
- `dyno` helpers

CLI mock authoring types:

- `CliMockResponse`
- `CliMockHandlerContext`
- `CliMockConfig`
- `ScenarioCliMocks`

`defineDyno(...)` also applies authoring defaults for JavaScript and
TypeScript dynos: adjacent `fixtures/` directories are attached to scenarios
that do not set `fixtures`, and dynos authored under `.agents/skills/<name>/`
or `.claude/skills/<name>/` get setup commands that copy that skill's
`SKILL.md` into both `.agents/skills/<name>/` and `.claude/skills/<name>/` in
the scenario work directory.

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
