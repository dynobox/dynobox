---
name: dyno-create
description: |
  Author Dynobox test files (*.dyno.yaml and *.dyno.yml, or the js/ts variety) for
  agent and skill workflow testing with Claude Code or OpenAI Codex. Use this skill
  when the user wants to write, scaffold, generate, review, or edit dyno tests,
  dynobox configs, scenarios, assertions, fixtures, or evaluation harnesses,
  including requests involving tool calls, shell commands, skill references,
  artifacts, transcripts, final messages, ordered sequences, or HTTP requests.
---

# Dyno Authoring

Dynobox is a local test runner for agent and skill workflows. A dyno sends a
prompt to one or more harnesses, then asserts on observable behavior: tool calls,
files in the scratch workdir, HTTP traffic, transcripts, and final messages.

Assume the user is authoring for the public `dynobox` CLI unless they explicitly
say they are working against a local Dynobox build.

YAML and JS/TS dynos share one schema. YAML uses plain `type`-discriminated
objects instead of SDK helpers like `tool.called(...)` or `artifact.exists(...)`.

Use YAML for simple standalone dynos. Use JS/TS when the dyno benefits from
SDK helpers, colocated fixtures, path helpers, shared scenario fragments, or a
skill smoke-test layout.

## File Naming

For a new YAML dyno, default to:

```text
dynobox/<descriptive-slug>.dyno.yaml
```

For a skill smoke test in this repository, prefer the colocated JS convention:

```text
.agents/skills/<skill-name>/dyno/<skill-name>.dyno.mjs
.agents/skills/<skill-name>/dyno/fixtures/
```

`dynobox run` recursively discovers:

```text
*.dyno.{yaml,yml,mjs,js,ts,mts}
```

Explicit paths can use other names if the content is valid:

```bash
dynobox run path/to/dynobox.config.yaml
```

## JS/TS Dynos

Use SDK helpers for JS/TS dynos:

```js
import {defineDyno, dyno, finalMessage, skill, tool} from '@dynobox/sdk';

const here = dyno.here(import.meta.url);

export default defineDyno({
  name: 'skill-smoke-test',
  scenarios: [
    {
      name: 'skill reads fixture and reports result',
      prompt:
        'Use the demo skill to inspect input.txt and report whether it mentions tests.',
      setup: [
        'mkdir -p .agents/skills/demo',
        `cp ${here.q('../SKILL.md')} .agents/skills/demo/SKILL.md`,
      ],
      assertions: [
        skill.referenced('demo'),
        tool.called('read_file', {path: 'input.txt'}),
        finalMessage.contains('tests'),
      ],
    },
  ],
});
```

When using `defineDyno(...)` in a JS/TS dyno, an adjacent `fixtures/` directory
is automatically copied into each scenario work directory when the scenario does
not explicitly set `fixtures`. If the example above has:

```text
dyno/fixtures/input.txt
```

the prompt and assertions can refer to `input.txt` directly. Do not manually
copy adjacent fixtures in `setup` unless you intentionally need a different path
or filename. For non-adjacent fixture directories, use `here.fixtures(...)` or
`dyno.fromUrl(...)` explicitly in the scenario's `fixtures` field.

## Top-Level Shape

```yaml
name: package-script-check
harnesses:
  - claude-code
setup:
  - echo shared setup
endpoints:
  npmPrettier:
    method: GET
    url: https://registry.npmjs.org/prettier
scenarios:
  - id: detects-test-script
    name: detects test script
    prompt: >-
      Inspect package.json and tell me whether this project has a test script.
    assertions:
      - type: finalMessage.contains
        text: test
```

Rules:

- `scenarios` is required and must contain at least one scenario.
- Top-level `setup` runs before every scenario's setup.
- Top-level `endpoints` are available to every scenario.
- Top-level `harnesses` is the default for scenarios that omit `harnesses`.
- Scenario-level `harnesses` replaces the top-level list.

## Scenario Shape

```yaml
- id: optional-stable-id
  name: required human-readable name
  prompt: >-
    Required user instruction sent to the harness.
  harnesses:
    - claude-code
  setup:
    - mkdir -p src
    - |
      cat > src/index.js <<'JS'
      console.log('hi');
      JS
  endpoints:
    localApi:
      method: GET
      url: https://example.test/data
  assertions:
    - type: artifact.exists
      path: src/index.js
```

Each scenario runs in a fresh temporary work directory. Anything the agent needs
to read must be created by setup, copied in by fixture support if available, or
already provided by the harness environment.

Use folded block scalars for prompts:

```yaml
prompt: >-
  Inspect package.json and tell me whether this project has a test script.
```

Use literal block scalars for heredoc setup commands:

```yaml
setup:
  - |
    cat > package.json <<'JSON'
    {"scripts":{"test":"vitest run"}}
    JSON
```

## Harnesses

Plain form:

```yaml
harnesses:
  - claude-code
  - codex
```

Object form:

```yaml
harnesses:
  - id: claude-code
    model: sonnet
  - id: codex
    model: gpt-5.1
    permissionMode: dangerous
```

Supported harness IDs are `claude-code` and `codex`.

Permission modes:

- `default`: use the harness's normal sandbox and approvals.
- `dangerous`: full-access mode for trusted local evals only.

When testing the same scenario across multiple harnesses, keep assertions as
harness-agnostic as possible. Different harnesses may combine commands or use
different tool surfaces for equivalent behavior.

## Assertions

Every assertion has a `type`. Optional `id` gives a stable report reference, and
optional `label` gives human-readable CLI output.

### tool.called and tool.notCalled

```yaml
- type: tool.called
  tool: shell
- type: tool.notCalled
  tool: edit_file
```

Common tool kinds:

```text
shell, read_file, write_file, edit_file, search_files, web_fetch, web_search,
mcp, task, unknown
```

For `shell`, add exactly one command matcher:

```yaml
- type: tool.called
  tool: shell
  command:
    includes: package.json

- type: tool.notCalled
  tool: shell
  command:
    matches: 'rm\s+-rf'
```

Matcher keys:

```text
equals, includes, startsWith, matches
```

`matches` is a JavaScript regex source string.

For file-oriented tools, use `path` to assert the file path instead of matching
a shell command:

```yaml
- type: tool.called
  tool: read_file
  path: matrix-failure-output.txt

- type: tool.notCalled
  tool: read_file
  path: secrets.txt
```

In JS/TS dynos, use the matching SDK helper form:

```js
tool.called('read_file', {path: 'matrix-failure-output.txt'});
tool.notCalled('read_file', {path: 'secrets.txt'});
```

Path matchers are supported for `read_file`, `write_file`, `edit_file`, and
`search_files`. They match path-like tool input fields such as `path`,
`file_path`, `filepath`, `file`, or nested entries like `files[].path`.

### artifact.exists and artifact.contains

Artifacts are read from the scenario work directory after the harness exits.

```yaml
- type: artifact.exists
  path: README.md

- type: artifact.contains
  path: package.json
  text: vitest run
```

Paths must be relative and stay inside the work directory.

### transcript.contains and finalMessage.contains

```yaml
- type: transcript.contains
  text: package.json

- type: finalMessage.contains
  text: test script
```

Use `finalMessage.contains` for the user-visible answer. Use
`transcript.contains` when the relevant evidence may appear before the final
assistant message.

### skill.referenced

Asserts that observed harness events referenced a named skill's `SKILL.md`.

```yaml
- type: skill.referenced
  skill: commit
```

This is useful for testing observable skill-file references, not general task success.

### sequence.inOrder

Use only when order is the behavior under test.

```yaml
- type: sequence.inOrder
  steps:
    - type: tool.called
      tool: shell
      command:
        includes: package.json
    - type: tool.called
      tool: shell
      command:
        includes: pnpm test
```

For shell calls, a single compound command can satisfy ordered steps if the
matchers appear in order within the command text.

### http.called and http.notCalled

HTTP assertions reference endpoint keys declared under `endpoints`.

```yaml
endpoints:
  npmPrettier:
    method: GET
    url: https://registry.npmjs.org/prettier
scenarios:
  - name: fetches prettier metadata
    prompt: Look up the latest version of prettier from npm.
    assertions:
      - type: http.called
        endpoint: npmPrettier
        status: 200
```

Endpoint keys may contain only letters, numbers, underscores, and hyphens.

HTTP capture works for child-process tools that honor proxy and CA environment
variables. Harness-native web tools with separate trust stores may bypass it.

## Authoring Workflow

1. Identify the observable behavior that proves success. Prefer file artifacts,
   tool calls, and final-message content over brittle transcript wording.
2. Pick harnesses. Default to `claude-code` unless the user asks for Codex or a
   matrix.
3. Create the minimum setup fixture needed for the task.
4. Write the prompt like a real user request. Do not leak assertion details into
   the prompt unless those details are part of the actual workflow.
5. Add at least one assertion. A scenario with no assertions only proves that
   the harness exited.
6. Prefer durable assertions:
   - `artifact.exists` or `artifact.contains` for produced files
   - `tool.called` for required interactions
   - `tool.notCalled` for dangerous or wrong behavior
   - `finalMessage.contains` for user-visible answers
   - `skill.referenced` when testing observed skill file references
7. Use `sequence.inOrder` sparingly. It is powerful, but easy to make too
   brittle across harnesses.

## Skill Smoke Tests

For skill smoke tests, keep the scratch repo realistic and make the skill
available inside the work directory:

```js
setup: [
  'mkdir -p .agents/skills/<skill-name>',
  `cp ${here.q('../SKILL.md')} .agents/skills/<skill-name>/SKILL.md`,
];
```

Then assert both routing and behavior:

```js
assertions: [
  skill.referenced('<skill-name>'),
  tool.called('read_file', {path: 'input.txt'}),
  finalMessage.contains('Expected section'),
];
```

Use adjacent `fixtures/` for long sample inputs, captured command output,
package fixtures, and other static files. Keep prompts short and user-like:
ask the agent to inspect a fixture file rather than pasting long fixture content
into the prompt. Use `artifact.contains` for final file mutations, path-aware
`tool.called` assertions for required reads, and `tool.notCalled` for forbidden
actions such as publishing, pushing, deleting, or rerunning a command the user
explicitly said was already run.

## Complete Example

```yaml
name: package-script-check
harnesses:
  - claude-code
scenarios:
  - id: detects-test-script
    name: detects test script
    prompt: >-
      Inspect package.json and tell me whether this project has a test script.
    setup:
      - |
        cat > package.json <<'JSON'
        {
          "name": "fixture",
          "scripts": {"test": "vitest run"}
        }
        JSON
    assertions:
      - label: reads package.json
        type: tool.called
        tool: read_file
        path: package.json
      - type: tool.notCalled
        tool: edit_file
      - type: artifact.contains
        path: package.json
        text: vitest run
      - type: finalMessage.contains
        text: test
```

Run it with:

```bash
dynobox run dynobox/package-script-check.dyno.yaml --debug
```

## Common Pitfalls

- Use `type`, `tool`, and `command`. Do not use old field names like `kind`,
  `toolKind`, or `matcher`.
- Use `command` only with `tool: shell`.
- Use `path` only with file-oriented tools: `read_file`, `write_file`,
  `edit_file`, or `search_files`.
- Do not manually copy an adjacent JS/TS dyno `fixtures/` directory when using
  `defineDyno(...)`; it is auto-copied unless `fixtures` is set explicitly.
- Use exactly one command matcher key.
- Quote regex matchers as strings.
- Keep artifact paths relative; do not use absolute paths or `..` escapes.
- Use `- |` for setup heredocs so YAML preserves newlines and quotes.
- Keep long captured outputs or source fixtures in fixture files, not in the
  prompt.
- Do not over-assert exact command order unless order is the point of the test.
- Be careful with `--harness codex` while debugging: it may replace configured
  harness objects and drop a model pinned in the dyno.

## Output Expectations

When creating or editing a dyno:

- Write the dyno file unless the user only asked for advice.
- Default to `dynobox/<slug>.dyno.yaml` for simple standalone YAML dynos.
- For repo skill smoke tests, prefer
  `.agents/skills/<skill-name>/dyno/<skill-name>.dyno.mjs`.
- Include at least one meaningful assertion.
- Keep prompts direct and user-like.
- Mention the run command:

```bash
dynobox run path/to/file.dyno.yaml --debug
```
