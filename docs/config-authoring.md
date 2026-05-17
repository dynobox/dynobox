# Config Authoring

Dynobox tests live in `*.dyno.{mjs,js,ts,mts,yaml,yml}` files. TypeScript and
JavaScript files default-export `defineDyno(...)` from `@dynobox/sdk`. YAML
files use the same shape as a plain document — assertions are declared with a
`kind` discriminator (see [YAML Configs](#yaml-configs) below).

`dynobox run` discovers every dyno file under the target directory; each file
is compiled and executed independently.

> `.cjs` and `.cts` extensions are not supported: `@dynobox/sdk` is ESM-only
> (its `exports` map has no `"require"` condition), so a CommonJS config
> calling `require('@dynobox/sdk')` fails at load time. Use `.mjs`/`.mts` or
> `.ts`/`.js` with `"type": "module"` instead.

```ts
import {defineDyno, tool} from '@dynobox/sdk';

export default defineDyno({
  name: 'local-observability',
  harnesses: [{id: 'claude-code', permissionMode: 'default'}],
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

Harness objects can also set `permissionMode`:

```ts
harnesses: [
  {id: 'claude-code', permissionMode: 'default'},
  {id: 'codex', model: 'gpt-5.1', permissionMode: 'dangerous'},
];
```

Permission modes are:

- `default`: use the harness's normal permission and sandbox behavior. This is the secure default.
- `dangerous`: opt into harness-specific full-access or permission-bypass flags for trusted local evals.

For `claude-code`, `dangerous` adds `--permission-mode bypassPermissions`. For `codex`, `dangerous` adds `--sandbox danger-full-access -c approval_policy="never"`.

The CLI also supports runtime harness overrides with `--harness` and runtime permission overrides with `--permission-mode`.

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

The local runner captures HTTP traffic from harness child processes through a local proxy and evaluates matching `http.called` / `http.notCalled` assertions.

Endpoint keys become part of stable IR ids, so they may only contain letters, numbers, underscores, and hyphens.

### How HTTP capture works

When a scenario includes HTTP assertions, Dynobox starts a per-job local proxy and sets `HTTP_PROXY` / `HTTPS_PROXY` on the harness child process. It also sets `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, and `CURL_CA_BUNDLE` to a Dynobox-generated CA at `~/.dynobox/ca.pem` so common Node, Python, and curl-based tools can make HTTPS requests through the proxy without changing the system keychain.

HTTP capture covers local child-process traffic that honors those proxy and CA environment variables. Tools with their own trust stores, such as some Go and Java binaries, may bypass HTTPS capture. Harness-native web tools such as built-in web search or web fetch can also bypass the local proxy if their network request happens outside the harness child process.

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

## YAML Configs

YAML dyno files use the same top-level shape as the TypeScript form. The only
difference is that helper calls like `tool.called('shell', {includes: 'x'})`
are written as plain objects discriminated by a `kind` field.

```yaml
name: package-script-skill
harnesses:
  - id: claude-code
    permissionMode: default
scenarios:
  - name: detects test script
    prompt: >-
      Inspect package.json and tell me whether this project has a test script.
    setup:
      - |
        cat > package.json <<'JSON'
        {"scripts":{"test":"vitest run"}}
        JSON
    assertions:
      - kind: tool.called
        toolKind: shell
        matcher:
          includes: package.json
      - kind: tool.notCalled
        toolKind: edit_file
      - kind: artifact.contains
        path: package.json
        text: vitest run
      - kind: finalMessage.contains
        text: test
```

YAML configs flow through the same Zod schema and IR compiler as TypeScript
configs, so runtime behavior is identical.

### Assertion `kind` reference

The following table maps each TypeScript helper to its YAML form.

| TypeScript helper                                      | YAML object                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------ |
| `tool.called('shell')`                                 | `{kind: tool.called, toolKind: shell}`                             |
| `tool.called('shell', {includes: 'x'})`                | `{kind: tool.called, toolKind: shell, matcher: {includes: x}}`     |
| `tool.notCalled('edit_file')`                          | `{kind: tool.notCalled, toolKind: edit_file}`                      |
| `artifact.exists('README.md')`                         | `{kind: artifact.exists, path: README.md}`                         |
| `artifact.contains('pkg.json', 'foo')`                 | `{kind: artifact.contains, path: pkg.json, text: foo}`             |
| `transcript.contains('done')`                          | `{kind: transcript.contains, text: done}`                          |
| `finalMessage.contains('ok')`                          | `{kind: finalMessage.contains, text: ok}`                          |
| `skill.invoked('commit')`                              | `{kind: skill.invoked, skill: commit}`                             |
| `sequence.inOrder([tool.called('shell', {...}), ...])` | `{kind: sequence.inOrder, steps: [{kind: tool.called, ...}, ...]}` |
| `http.called('npmPrettier', {status: 200})`            | `{kind: http.called, endpoint: npmPrettier, status: 200}`          |
| `http.notCalled('leftPad')`                            | `{kind: http.notCalled, endpoint: leftPad}`                        |

Matcher shapes accept exactly one of `equals`, `includes`, `startsWith`,
`matches` and are only valid on `shell` tool assertions.

When YAML parsing fails, the CLI emits a `line:column` pointer into the file so
syntax errors are easy to locate.
