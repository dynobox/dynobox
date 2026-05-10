# Config Authoring

Dynobox configs are TypeScript files loaded by the CLI. A config should default-export `defineDyno(...)` from `@dynobox/sdk`.

```ts
import {defineDyno, tool} from '@dynobox/sdk';

export default defineDyno({
  name: 'local-observability',
  scenarios: [
    {
      name: 'inspect package scripts',
      prompt:
        'Use a shell command that reads package.json and tell me whether a test script exists.',
      setup: [
        `cat > package.json <<'JSON'
{"scripts":{"test":"vitest run"}}
JSON`,
      ],
      assertions: [
        tool.called('shell'),
        tool.called('shell', {includes: 'package.json'}),
      ],
    },
  ],
});
```

## Config Shape

```ts
type DynoboxConfig = {
  name?: string;
  version?: string;
  harnesses?: HarnessRunConfig[];
  setup?: string[];
  endpoints?: Record<string, Endpoint>;
  scenarios: ScenarioInput[];
};
```

Top-level `setup` commands and `endpoints` are merged into each scenario. Top-level `harnesses` apply when a scenario does not define its own `harnesses`; scenario harnesses replace the top-level harness list.

## Scenario Shape

```ts
type ScenarioInput = {
  name: string;
  prompt: string;
  harnesses?: HarnessRunConfig[];
  setup?: string[];
  endpoints?: Record<string, Endpoint>;
  assertions?: Assertion[];
};
```

Scenario `setup` commands run in a fresh temporary work directory before the harness prompt. The prompt runs with that work directory as the harness current directory.

## Harnesses

Supported harness IDs are:

- `claude-code`
- `codex`

Use a string when the default model is fine:

```ts
harnesses: ['claude-code', 'codex'];
```

Use an object when you want a model-specific run:

```ts
harnesses: [
  {id: 'claude-code', model: 'sonnet'},
  {id: 'codex', model: 'gpt-5.1'},
];
```

The CLI also supports runtime harness overrides with `--harness`.

## Tool Assertions

Use `tool.called` and `tool.notCalled` to assert observed harness tool usage.

```ts
tool.called('shell');
tool.notCalled('web_fetch');
tool.called('shell', {includes: 'package.json'});
tool.notCalled('shell', {matches: 'rm\\s+-rf'});
```

Supported tool kinds are:

- `shell`
- `read_file`
- `write_file`
- `edit_file`
- `search_files`
- `web_fetch`
- `web_search`
- `mcp`
- `task`
- `unknown`

Shell tool assertions can include exactly one matcher:

- `{equals: 'pnpm test'}`
- `{includes: 'package.json'}`
- `{startsWith: 'pnpm'}`
- `{matches: 'pnpm\\s+test'}`

`matches` is a JavaScript regular expression string.

## Sequence Assertions

Use `sequence.inOrder` when order matters.

```ts
sequence.inOrder([
  tool.called('shell', {includes: 'package.json'}),
  tool.called('shell', {includes: 'pnpm test'}),
]);
```

For shell commands, ordered sequence matching can match multiple steps against one compound shell command when the commands appear in order.

## Skill Assertions

Use `skill.invoked` to assert that the harness accessed a named skill's `SKILL.md` instruction file.

```ts
skill.invoked('commit');
```

This passes when observed tool events reference `.agents/skills/<name>/SKILL.md` or `.claude/skills/<name>/SKILL.md`, including reads, searches, or shell commands that access the file.

## Artifact Assertions

Artifact assertions read files inside the scenario work directory.

```ts
artifact.exists('README.md');
artifact.contains('package.json', 'vitest run');
```

Artifact paths must be relative and must stay inside the work directory.

## Transcript And Final Message Assertions

Use transcript assertions to inspect the raw harness transcript and final-message assertions to inspect the final response extracted from the harness output.

```ts
transcript.contains('package.json');
finalMessage.contains('test script');
```

Final-message extraction depends on the harness output format. If a harness does not provide a final message, the assertion fails with a clear message.

## HTTP Helpers

The SDK can declare HTTP endpoints and assertions:

```ts
endpoints: {
  npmPrettier: http.endpoint({
    method: 'GET',
    url: 'https://registry.npmjs.org/prettier',
  }),
},
assertions: [http.called('npmPrettier', {status: 200})];
```

These helpers are useful for type-checking and future configs, but the local runner does not yet capture HTTP traffic or evaluate HTTP assertions.

Endpoint keys become part of stable IR ids, so they may only contain letters, numbers, underscores, and hyphens.

## Path Helpers

The `dyno` helper is useful when config files need stable paths relative to the config module.

```ts
const here = dyno.here(import.meta.url);

setup: [`cp ${here.q('./fixtures/input.txt')} input.txt`];
```

Available helpers:

- `dyno.fsPath(url)`
- `dyno.fromUrl(baseUrl, path)`
- `dyno.shellQuote(value)` / `dyno.q(value)`
- `dyno.here(import.meta.url).path(path)`
- `dyno.here(import.meta.url).q(path)`

## Single Scenario Authoring

Use `defineScenario` when you want to author or export a scenario independently, then include it in a config.

```ts
import {defineDyno, defineScenario, tool} from '@dynobox/sdk';

const checksPackageJson = defineScenario({
  name: 'checks package json',
  prompt: 'Read package.json and summarize the scripts.',
  assertions: [tool.called('shell', {includes: 'package.json'})],
});

export default defineDyno({
  scenarios: [checksPackageJson],
});
```
