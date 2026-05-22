# Config Authoring

Dynobox configs describe what to run and what to assert. A config can be
authored as JavaScript, TypeScript, or YAML.

Directory discovery loads files named `*.dyno.{mjs,js,ts,mts,yaml,yml}`.
Explicit file paths can use other names, such as `dynobox.config.ts`, as long
as the file is a loadable Dynobox config.

CommonJS config files (`.cjs` and `.cts`) are not supported because
`@dynobox/sdk` is ESM-only.

## Minimal Config

```ts
import {defineDyno, tool} from '@dynobox/sdk';

export default defineDyno({
  name: 'local-observability',
  harnesses: ['claude-code'],
  scenarios: [
    {
      name: 'inspect package scripts',
      setup: [
        `cat > package.json <<'JSON'
{"scripts":{"test":"vitest run"}}
JSON`,
      ],
      prompt:
        'Use a shell command that reads package.json and tell me whether a test script exists.',
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

Top-level `setup` commands and `endpoints` are merged into each scenario.
Top-level `harnesses` apply when a scenario does not define its own harnesses.
Scenario harnesses replace the top-level harness list.

```ts
type ScenarioInput = {
  id?: string;
  name: string;
  prompt: string;
  harnesses?: HarnessRunConfig[];
  setup?: string[];
  endpoints?: Record<string, Endpoint>;
  assertions?: Assertion[];
};
```

Each scenario runs in a fresh temporary work directory. Setup commands run in
that directory before the harness prompt, and artifact assertions read files
from that directory after the harness exits.

Scenario `id` is optional. When provided, it is used for stable compiled
scenario IDs, job IDs, and `dynobox run --scenario` filters. Without an `id`,
Dynobox derives one from the scenario name.

## Harnesses

Supported harness IDs:

- `claude-code`
- `codex`

Use strings when the default model and permission behavior are fine:

```ts
harnesses: ['claude-code', 'codex'];
```

Use objects to set a model or permission mode:

```ts
harnesses: [
  {id: 'claude-code', model: 'sonnet'},
  {id: 'codex', model: 'gpt-5.1', permissionMode: 'dangerous'},
];
```

Permission modes:

- `default`: use the harness's normal permission and sandbox behavior.
- `dangerous`: opt into harness-specific full-access or permission-bypass flags
  for trusted local evals.

Dangerous mode maps to:

- `claude-code`: `--permission-mode bypassPermissions`
- `codex`: `--sandbox danger-full-access -c approval_policy="never"`

The CLI can override authored harnesses with `--harness` and authored
permission modes with `--permission-mode`.

## Assertions

Assertions are evaluated against observed harness behavior after each scenario
runs.

### Tool Calls

Use `tool.called` and `tool.notCalled` to assert tool usage.

```ts
tool.called('shell');
tool.notCalled('web_fetch');
tool.called('shell', {includes: 'package.json'});
tool.notCalled('shell', {matches: 'rm\\s+-rf'});
```

Supported tool kinds:

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

Shell tool assertions can include exactly one command matcher:

- `{equals: 'pnpm test'}`
- `{includes: 'package.json'}`
- `{startsWith: 'pnpm'}`
- `{matches: 'pnpm\\s+test'}`

`matches` is a JavaScript regular expression string. Command matchers are only
valid on `shell` tool assertions.

### Ordered Sequences

Use `sequence.inOrder` when order matters.

```ts
sequence.inOrder([
  tool.called('shell', {includes: 'package.json'}),
  tool.called('shell', {includes: 'pnpm test'}),
]);
```

For shell commands, ordered matching can match multiple steps against one
compound command when the command text appears in order.

### Skills

Use `skill.invoked` to assert that the harness accessed a named skill's
`SKILL.md` instruction file.

```ts
skill.invoked('commit');
```

This passes when observed tool events reference
`.agents/skills/<name>/SKILL.md` or `.claude/skills/<name>/SKILL.md`, including
reads, searches, or shell commands that access the file.

### Artifacts

Artifact assertions read files inside the scenario work directory.

```ts
artifact.exists('README.md');
artifact.contains('package.json', 'vitest run');
```

Artifact paths must be relative and must stay inside the work directory.

### Transcript And Final Message

Use transcript assertions to inspect the full harness transcript. Use
final-message assertions to inspect the final assistant response extracted from
the harness output.

```ts
transcript.contains('package.json');
finalMessage.contains('test script');
```

Final-message extraction depends on the harness output format. If a harness
does not provide a final message, the assertion fails with a clear message.

## HTTP Assertions

Declare endpoints with `http.endpoint(...)` and assert whether matching
requests were observed.

```ts
endpoints: {
  npmPrettier: http.endpoint({
    method: 'GET',
    url: 'https://registry.npmjs.org/prettier',
  }),
},
assertions: [http.called('npmPrettier', {status: 200})];
```

Endpoint keys become part of stable IR ids, so they may only contain letters,
numbers, underscores, and hyphens.

Endpoint specs also accept `headers`, `body`, and `response` fields. The
current local runner preserves those fields in the compiled IR, but HTTP
assertions match observed requests by endpoint URL/method and optional response
status. It does not use those fields to mock or shape requests yet.

When a scenario includes HTTP assertions, Dynobox starts a per-job local proxy
and sets proxy environment variables on the harness child process:

- `HTTP_PROXY`
- `HTTPS_PROXY`
- `http_proxy`
- `https_proxy`

Dynobox also sets common CA variables to a generated CA at
`~/.dynobox/ca.pem`:

- `NODE_EXTRA_CA_CERTS`
- `SSL_CERT_FILE`
- `REQUESTS_CA_BUNDLE`
- `CURL_CA_BUNDLE`

HTTP capture covers local child-process traffic that honors those proxy and CA
environment variables. Harness-native web tools and binaries with their own
trust stores may bypass capture.

## Path Helpers

The `dyno` helper is useful when config files need stable paths relative to the
config module.

```ts
import {dyno} from '@dynobox/sdk';

const here = dyno.here(import.meta.url);

setup: [`cp ${here.q('./fixtures/input.txt')} input.txt`];
```

Available helpers:

- `dyno.fsPath(url)`
- `dyno.fromUrl(baseUrl, path)`
- `dyno.shellQuote(value)` or `dyno.q(value)`
- `dyno.here(import.meta.url).path(path)`
- `dyno.here(import.meta.url).q(path)`

## Reusable Scenarios

Use `defineScenario` when you want to author or export a scenario
independently, then include it in a dyno.

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

YAML dynos use the same top-level shape as JavaScript and TypeScript configs.
The difference is that helper calls are written as plain objects using the same
authoring assertion shape that SDK helpers return.

```yaml
name: package-script-check
harnesses:
  - claude-code
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
      - label: reads package.json
        type: tool.called
        tool: shell
        command:
          includes: package.json
      - type: tool.notCalled
        tool: edit_file
      - type: artifact.contains
        path: package.json
        text: vitest run
      - type: finalMessage.contains
        text: test
```

YAML configs flow through the same schema and IR compiler as JavaScript and
TypeScript configs.

## Authoring Assertion Contract

All assertion objects accept optional `id` and `label` fields. `id` stabilizes
compiled assertion IDs and JSON report references. `label` appears in CLI and
JSON output.

| TypeScript helper                                      | Authoring object                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------ |
| `tool.called('shell')`                                 | `{type: tool.called, tool: shell}`                                 |
| `tool.called('shell', {includes: 'x'})`                | `{type: tool.called, tool: shell, command: {includes: x}}`         |
| `tool.notCalled('edit_file')`                          | `{type: tool.notCalled, tool: edit_file}`                          |
| `artifact.exists('README.md')`                         | `{type: artifact.exists, path: README.md}`                         |
| `artifact.contains('pkg.json', 'foo')`                 | `{type: artifact.contains, path: pkg.json, text: foo}`             |
| `transcript.contains('done')`                          | `{type: transcript.contains, text: done}`                          |
| `finalMessage.contains('ok')`                          | `{type: finalMessage.contains, text: ok}`                          |
| `skill.invoked('commit')`                              | `{type: skill.invoked, skill: commit}`                             |
| `sequence.inOrder([tool.called('shell', {...}), ...])` | `{type: sequence.inOrder, steps: [{type: tool.called, ...}, ...]}` |
| `http.called('npmPrettier', {status: 200})`            | `{type: http.called, endpoint: npmPrettier, status: 200}`          |
| `http.notCalled('leftPad')`                            | `{type: http.notCalled, endpoint: leftPad}`                        |

Command matcher shapes accept exactly one of `equals`, `includes`,
`startsWith`, or `matches`, and are only valid on `shell` tool assertions.

Older YAML objects that used `kind`, `toolKind`, or `matcher` are not accepted.
Use `type`, `tool`, and `command` instead.

When YAML parsing fails, the CLI emits a `line:column` pointer into the file so
syntax errors are easy to locate.
