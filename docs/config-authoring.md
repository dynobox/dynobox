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
import {command, defineDyno, finalMessage} from '@dynobox/sdk';

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
        'Use `cat package.json` and tell me whether a test script exists.',
      assertions: [
        command.called('cat', {args: ['package.json']}),
        finalMessage.contains('test'),
      ],
    },
  ],
});
```

## Config Shape

```ts
type DynoboxConfig = {
  name?: string;
  target?: string;
  version?: string;
  harnesses?: HarnessRunConfig[];
  setup?: string[];
  endpoints?: Record<string, Endpoint>;
  scenarios: ScenarioInput[];
};
```

Top-level `setup` commands and `endpoints` are merged into each scenario.
Top-level `harnesses` apply when a scenario does not define its own harnesses.
Scenario harnesses replace the top-level harness list. If neither the scenario
nor the top-level config defines harnesses, Dynobox defaults that scenario to
`claude-code`.

`target` names the thing being tested (for example `github-pr-agent`). Dynos
that share a target are grouped together in saved-run reporting and on the
dashboard, so several `.dyno` files can describe one product surface. When
omitted, the target defaults to the dyno file's parent directory name.

```ts
type ScenarioInput = {
  id?: string;
  name: string;
  prompt: string;
  harnesses?: HarnessRunConfig[];
  setup?: string[];
  fixtures?: string | string[];
  cliMocks?: ScenarioCliMocks;
  endpoints?: Record<string, Endpoint>;
  assertions?: Assertion[];
};
```

Each scenario runs in a fresh temporary work directory. Setup commands run in
that directory before the harness prompt, fixture directories are copied into
that directory before setup, and artifact assertions read files from that
directory after the harness exits.

Scenario `id` is optional. When provided, it is used for stable compiled
scenario IDs, job IDs, and `dynobox run --scenario` filters. Without an `id`,
Dynobox derives one from the scenario name. When running discovered files, the
CLI prefixes IDs with a source-file slug so JSON job and assertion IDs remain
unique across files; authored scenario IDs are still accepted by `--scenario`
filters with or without the `scenario.` prefix.

Scenario and assertion `id` values must be non-empty and may only contain
letters, numbers, dots, underscores, and hyphens.

## CLI Mocks

> **Experimental:** CLI mocking is an experimental feature. Its authoring and
> reporting contracts may change between releases.

Use scenario `cliMocks` to replace bare executable calls during the harness or
post-harness verification. Mocks are scoped to one job and support static
responses, ordered responses, and JavaScript or TypeScript handlers.

```ts
import {command, defineDyno} from '@dynobox/sdk';

export default defineDyno({
  scenarios: [
    {
      name: 'fixes tests and prepares a release',
      prompt: 'Fix the tests, then prepare a release.',
      cliMocks: {
        npm: {response: {exitCode: 0, stdout: '0.10.2'}},
        vitest: {
          responses: [
            {exitCode: 1, stderr: 'one test failed'},
            {exitCode: 0, stdout: 'all tests passed'},
          ],
          onExhausted: 'repeat-last',
        },
        changeset: {
          handler: async ({argv}) => ({
            exitCode: argv[0] === 'version' ? 0 : 1,
          }),
        },
      },
      assertions: [
        command.called('vitest', {args: ['run']}),
        command.called('changeset', {args: ['version']}),
      ],
    },
  ],
});
```

Configuration rules:

- Each executable configures exactly one of `response`, `responses`, or
  `handler`. Keys must be bare executable names, not paths, `.`, or `..`.
- Every response needs an integer `exitCode` from 0 through 255; omitted output
  defaults to an empty string. Sequences default to an exhaustion error. Use
  `onExhausted` to repeat the last response or provide a fallback.
- Handlers receive `argv`, `cwd`, and the child environment, which may contain
  secrets. Treat them as trusted code, keep their work bounded, and account for
  concurrent jobs. Async handlers time out after 30 seconds without cancellation.
  Call records omit environment values.

Dynobox prepends generated shims to `PATH` for the harness and verification
commands, including nested processes. Setup and harness version detection use
the real `PATH`. Shell startup hooks protect the mock path for common zsh, bash,
and interactive POSIX `sh` flows; npm and pnpm scripts are also covered. Custom
shell profiles, other shells, restrictive Codex environment filtering, and Yarn
scripts may restore a real executable ahead of a shim.

Explicit paths, shell builtins, functions, aliases, and keywords bypass `PATH`
lookup. CLI mocks are therefore behavioral test doubles, not a sandbox or
security boundary. Mocking the selected harness executable is rejected. CLI
mocks currently require macOS or Linux.

See [Mocked executables use call records](#mocked-executables-use-call-records)
for assertion and reporting behavior. A configured nonzero exit is an ordinary
response; sequence exhaustion, handler failures, timeouts, and unfinished calls
fail the job even if the harness catches the command error.

## Harnesses

Supported harness IDs:

- `claude-code`
- `codex`
- `opencode`
- `pi`
- `cursor`
- `antigravity`

Use strings when the default model and permission behavior are fine:

```ts
harnesses: ['claude-code', 'codex', 'opencode', 'pi', 'cursor', 'antigravity'];
```

Use objects to set a model or permission mode:

```ts
harnesses: [
  {id: 'claude-code', model: 'sonnet'},
  {id: 'codex', model: 'gpt-5.1', permissionMode: 'dangerous'},
  {id: 'opencode', model: 'openai/gpt-5.1'},
  {id: 'pi', model: 'anthropic/claude-sonnet-4-5'},
  {id: 'cursor', model: 'composer-2'},
  {id: 'antigravity', model: 'gemini-3.5-flash-medium'},
];
```

Permission modes:

- `default`: use the harness-specific non-dangerous headless behavior described
  in the [CLI reference](./cli.md#harness-requirements).
- `dangerous`: opt into harness-specific full-access or automatic permission
  approval flags for trusted local evals. See [Harness
  Requirements](./cli.md#harness-requirements) for exact mappings.

The CLI can override authored harnesses with `--harness` and authored
permission modes with `--permission-mode`.

## Assertions

Most assertions are evaluated against observed harness behavior after each
scenario runs. Verification assertions run after the harness and execute their
own checks against the completed work directory.

Use the assertion namespace that matches the behavior you care about:

- `tool.*` — the agent used, or avoided, a harness tool such as `shell`,
  `read_file`, or `edit_file`.
- `command.*` — the agent ran, or avoided, a normalized shell command such as
  `git commit`, `pnpm test`, or `cat package.json`.
- `http.*` — a declared endpoint request was, or was not, observed through
  local HTTP capture.
- `artifact.*` — files in the scenario work directory have the expected final
  state.
- `transcript.*` and `finalMessage.*` — the harness transcript or final response
  includes expected text.
- `skill.referenced(...)` — observed events referenced a skill instruction file.
- `verify.*` — Dynobox runs a post-harness check, such as validating a file the
  agent produced.

Prefer the most semantic assertion available. For example, use
`command.called('git', {args: ['commit']})` to assert observed CLI behavior,
then use `artifact.contains(...)` or `verify.command(...)` to check the final
result.

### Tool Calls

Use `tool.called` and `tool.notCalled` to assert tool usage.

```ts
tool.called('read_file', {path: 'package.json'});
tool.notCalled('edit_file', {path: 'src/index.ts'});
tool.notCalled('web_fetch');
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

Shell tool assertions can include exactly one raw shell command matcher:

- `{equals: 'pnpm test'}`
- `{includes: 'package.json'}`
- `{startsWith: 'pnpm'}`
- `{matches: 'pnpm\\s+test'}`

`matches` is a JavaScript regular expression string. Shell command matchers are
only valid on `shell` tool assertions.

Prefer `command.*` for normal CLI behavior assertions. Raw shell string matchers
remain available as escape hatches when command normalization does not support a
shell form you need to check, such as a complex heredoc, substitution, or
wrapper-specific command line.

File-oriented tool assertions can include a path matcher:

- `tool.called('read_file', {path: 'package.json'})`
- `tool.called('write_file', {path: 'src/index.ts'})`
- `tool.called('edit_file', {path: 'src/index.ts'})`
- `tool.called('search_files', {path: 'src'})`

Path matchers are valid on `read_file`, `write_file`, `edit_file`, and
`search_files` tool assertions. They match path fields reported by the harness,
including common nested fields such as `path`, `file_path`, `filepath`, and
`file`. Tool assertions may specify either a shell command matcher or a path
matcher, not both.

### Commands

> **Experimental.** Command assertions are new; their matching behavior and
> matcher options may change in a future release.

`command.called` and `command.notCalled` assert on individual shell commands the
agent ran _during the harness_, after normalization, instead of regex-matching
the raw command string.

How it works: dynobox parses each observed shell command into normalized
`(executable, argv)` segments using best-effort shell parsing — it does **not**
run a real shell — and matches your assertion against those segments. This is
more robust than regex over raw command strings for common shapes (leading env
assignments, `bash -lc "…"` wrappers, executable path basenames, pipelines), but
it is intentionally incomplete; see [Limitations and
oddities](#limitations-and-oddities) below.

```ts
command.called('git', {args: ['status']});
command.called('git', {args: ['commit']});
command.notCalled('git', {args: ['push']});
command.called('pnpm', {argsInOrder: ['run', 'build']});
command.called('node', {argsMatching: [/--max-old-space-size=\d+/]});
command.called('git', {originalIncludes: '--no-verify'});
```

`command.*` is generic observed CLI behavior, not a Git/npm/Docker-specific API.
Use the executable name and argument matchers for any command Dynobox can
normalize.

#### Mocked executables use call records

For bare executables in `cliMocks`, completed call records are authoritative for
`command.called`, `command.notCalled`, and `sequence.inOrder`. This captures
package scripts and nested processes that may not appear directly in the
transcript, while transcript text alone cannot prove a command ran. Other
executables, including explicit paths that bypass a shim, use normalized shell
observations.

Observation assertions use calls captured through the end of the harness phase.
Verification calls still consume sequential responses and appear in reports,
but cannot satisfy those assertions. Mock lifecycle failures during either
phase still fail the job.

Mock-only sequences use invocation order. A nested or compound-shell mock call
cannot always be ordered against unrelated harness tool events; mixed sequence
assertions that require such a comparison fail with a diagnostic.

Match the first argument against the command's normalized `executable`. The
optional matcher accepts any combination of the following fields; when several
are given, **all** must match:

- `args` — every listed arg must appear in `argv` (order-independent).
- `argsInOrder` — the listed args must appear in `argv` in the given order
  (other args may appear between them).
- `argsMatching` — an array of `RegExp`; each must match at least one `argv`
  token.
- `originalIncludes` — substring match against the raw text of the single
  command segment.
- `originalMatches` — `RegExp` match against the raw text of the single command
  segment.

For a CLI mock call paired with a standalone shell event, `originalIncludes`
and `originalMatches` use that event's raw command segment. Nested, package
script, and other unpaired mock calls have no raw shell segment, so Dynobox
reconstructs this value by joining the recorded executable and arguments with
spaces. That reconstructed form does not preserve quoting or other shell
syntax; prefer `args`, `argsInOrder`, or `argsMatching` for unpaired mock calls.

With no matcher, `command.called('git')` passes if any observed command's
executable is `git`.

#### What normalization handles

- **Compound commands** are split on `;`, `&&`, `||`, `|`, and `|&` into
  separate command segments, so each side of a pipe or operator is matched
  independently. Separators inside `(...)` subshells and `{...}` brace groups
  are left intact until those wrappers are unwrapped.
- **Subshell and brace-group wrappers** are unwrapped:  
  `(npx dynobox validate tmp/x.dyno.yaml 2>&1; echo "EXIT: $?")` and  
  `{ npx dynobox validate tmp/x.dyno.yaml; echo "EXIT: $?"; }` normalize to the
  same observed commands as their ungrouped forms (`npx …` and `echo …`). Trailing
  redirections on the group are allowed
  (`{ …; } 2>&1`, `(…; echo done) >out`). This covers the common agent pattern
  of capturing exit codes in a group.
- **Leading environment assignments** are skipped: `NODE_ENV=test pnpm test`
  normalizes to executable `pnpm`.
- **Shell wrappers** are unwrapped: `bash -lc "git status"` (and `sh`/`zsh`,
  with any `-c`-style flag) normalizes to the inner command. Wrappers are
  unwrapped up to two levels deep.
- **Executable basename** is used: `/usr/bin/git status` normalizes to
  executable `git` (the full path is retained separately).
- **`git -C <dir>`** is recorded as the command's working directory; the
  harness-reported `cwd`/`workdir` is captured when present.
- **Redirection targets are excluded**: `git status > out.log` yields argv
  `['status']`, not `out.log`.
- **Shell variables and unquoted `#`** are preserved as literal arg text (for
  example `$PWD` and `owner/repo#123`).

#### Limitations and oddities

Normalization is deterministic but **incomplete** — it does not run a full
shell parser. The following are _not_ parsed, so commands hidden inside them are
not observed:

- **Backgrounding `&`** is not a separator. In `server & curl localhost`, only
  `server` is observed; `curl` is dropped. (`&&` and `|&` are handled; a bare
  `&` is not.)
- **Command/process substitution** (`$(...)`, `` `...` ``, `<(...)`) and
  `eval`, and commands invoked via wrappers like `xargs`, are not expanded.
- **Heredocs** and other multi-line constructs are not interpreted.
- **Shell wrappers** deeper than two levels are not unwrapped.
- **Shell comments** are dropped from a command's args, but a separator inside a
  comment (for example `git status # do it && rm -rf`) can still split the line,
  so text after it may be observed as its own command.
- `originalIncludes` / `originalMatches` match the text of a **single** command
  segment, not the whole compound line.

When `command.called` fails because no normalized command matches the expected
executable, but raw shell text still mentions that name, the failure message
calls out a possible normalization gap and includes the matching raw shell
line(s). That usually means the agent used a shell shape Dynobox does not yet
unwrap (for example `eval` or command substitution).

> `command.notCalled` is a behavioral check, not a security boundary. Because
> the constructs above are not parsed, a forbidden command concealed inside one
> (for example `eval "$(echo git push)"`) can evade detection. Do not rely on it
> to prove a command never ran.

### Ordered Sequences

Use `sequence.inOrder` when order matters.

```ts
sequence.inOrder([
  command.called('git', {args: ['status']}),
  command.called('git', {args: ['diff']}),
]);
```

Steps may be `tool.called(…)` matchers, `command.called(…)` matchers, or a mix
of both:

```ts
sequence.inOrder([
  command.called('git', {args: ['add']}),
  command.called('git', {args: ['commit']}),
]);
```

For shell commands, ordered matching can match multiple steps against one
compound command when the command text appears in order. Normalized command
steps are ordered by their position within the compound command, including
segments nested inside shell wrappers.

### Union Assertions (`anyOf`)

Use `anyOf` when any one of several assertion paths is acceptable.

```ts
anyOf([
  tool.called('read_file', {path: 'package.json'}),
  command.called('cat', {args: ['package.json']}),
  verify.succeeds('node --check out.js'),
]);
```

Branches may use any regular assertion kind except nested `anyOf` or
`sequence.inOrder`. Nested `verify.command(...)` / `verify.succeeds(...)`
branches are supported. Branch-level `id` and `label` fields are not supported;
label the `anyOf` assertion itself instead.

Every branch is evaluated on each run, even after one branch already passes.
When multiple branches pass, the lowest-index branch is reported as the match.
Observation branches (artifacts, tools, commands, and so on) are evaluated
before nested verification commands run, so a verify branch cannot mutate the
workdir and retroactively change an artifact branch result.

`*.notCalled` branches (`tool.notCalled`, `command.notCalled`, `http.notCalled`)
can make an `anyOf` pass vacuously when the forbidden action never occurred.
Prefer positive matchers (`tool.called`, `command.called`, `http.called`, and so
on) unless you deliberately want "either path A succeeded or path B was never
taken."

### Skills

Use `skill.referenced` to assert that observed harness events referenced a
named skill's `SKILL.md` instruction file.

```ts
skill.referenced('commit');
```

This passes when observed tool events reference
`.agents/skills/<name>/SKILL.md`, `.claude/skills/<name>/SKILL.md`, or
`.cursor/skills/<name>/SKILL.md`, including reads, searches, or shell commands
that access the file.

The name is intentionally narrow: Dynobox observes file references, not whether
a harness semantically activated or followed the skill instructions.

### Artifacts

Artifact assertions read paths inside the scenario work directory.

```ts
artifact.exists('README.md');
artifact.notExists('scratch.tmp');
artifact.contains('package.json', 'vitest run');
artifact.unchanged('package-lock.json');
```

- `artifact.exists(path)` passes when a directory entry is present after the
  harness runs. Dynobox uses `lstat` semantics, so valid and dangling symlinks
  both count as present.
- `artifact.notExists(path)` is the complement: it passes only when the path is
  truly absent (including when an intermediate component is a regular file, so
  `file/child` cannot exist). Files, directories, valid symlinks, and dangling
  symlinks all fail.
- `artifact.contains(path, text)` reads the file as UTF-8 and checks for a
  substring.
- `artifact.unchanged(path)` fingerprints the regular file after fixtures and
  setup complete (size + SHA-256 of raw bytes), then compares the same
  fingerprint after the harness exits. Equality is still raw-byte exact: line
  endings, whitespace, formatting, and structured data are not normalized.
  Missing, unreadable, or non-file baselines fail as assertion-level authoring
  errors without blocking the harness.

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

### Verification Commands

Use `verify.command` when Dynobox should run a command after the harness exits to
validate the completed work directory.

```ts
verify.succeeds('dynobox validate out.dyno.ts');
verify.command('dynobox validate out.dyno.ts', {exitCode: 0});
verify.command('dynobox validate out.dyno.ts', {
  exitCode: 0,
  stdout: {includes: 'valid'},
});
```

Verification commands are test-runner checks, not observed agent behavior. They
are useful for validating generated files, running a linter, or building an
artifact the agent created. They should not replace `tool.*`, `command.*`, or
`http.*` assertions when you need to prove what the agent actually did during
the harness run.

`verify.command` requires at least one expected `exitCode`, `stdout`, or
`stderr` matcher. Output matchers use the same text matcher shape as shell
command strings: `equals`, `includes`, `startsWith`, or `matches`.

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

Endpoint specs include only `method` and `url`. HTTP assertions match observed
requests by endpoint URL/method and optional response status.

When a scenario includes HTTP assertions, Dynobox starts a per-job local proxy
and sets `HTTP_PROXY`, `HTTPS_PROXY`, and their lowercase variants on the harness
child process. Existing `NO_PROXY` and `no_proxy` values are preserved, and local
loopback values (`localhost`, `127.0.0.1`, and `::1`) are added. A generated CA
at `~/.dynobox/ca.pem` is exposed through `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`,
`REQUESTS_CA_BUNDLE`, and `CURL_CA_BUNDLE`. Capture covers traffic that honors
those settings; harness-native web tools and clients with their own trust stores
may bypass it.

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
- `dyno.here(import.meta.url).fixtures(subpath?)`

`dyno.here(...).fixtures()` resolves the adjacent `fixtures/` directory, or a
subpath inside it. Use it when you need to attach a non-default fixture path
explicitly.

## Fixtures

Scenarios can attach one or more fixture directories. Dynobox recursively
copies each fixture directory into the scenario work directory before setup
commands run.

```ts
import {defineDyno, dyno, tool} from '@dynobox/sdk';

const here = dyno.here(import.meta.url);

export default defineDyno({
  scenarios: [
    {
      name: 'uses a fixture repo',
      prompt: 'Inspect package.json.',
      fixtures: here.fixtures('repo'),
      assertions: [tool.called('read_file', {path: 'package.json'})],
    },
  ],
});
```

When a JavaScript or TypeScript dyno uses `defineDyno(...)`, an adjacent
`fixtures/` directory is attached automatically to scenarios that do not set
`fixtures` themselves:

```text
my-skill.dyno.mjs
fixtures/
  package.json
```

With that layout, `fixtures/package.json` is copied to `package.json` in each
scenario work directory. Set `fixtures` explicitly to use a different
directory, or set `fixtures: []` to disable the adjacent fixture default.

YAML dynos can set `fixtures` explicitly, but they do not get automatic
adjacent fixture attachment because YAML configs do not execute
`defineDyno(...)`.

## Skill Dynos

When a JavaScript or TypeScript dyno using `defineDyno(...)` is authored under a
skill directory, Dynobox automatically copies that skill's `SKILL.md` into the
scenario work directory before scenario setup runs.

Supported skill roots:

- `.agents/skills/<name>/`
- `.claude/skills/<name>/`

For either authored root, Dynobox stages the same source `SKILL.md` into both
harness layouts:

- `.agents/skills/<name>/SKILL.md`
- `.claude/skills/<name>/SKILL.md`

The authored root is copied first, then the alternate destination. Authored
scenario setup commands run after both generated copies.

For example, a dyno at `.agents/skills/commit/dyno/commit.dyno.mjs` with
`.agents/skills/commit/SKILL.md` gets setup commands that create both
`.agents/skills/commit/SKILL.md` and `.claude/skills/commit/SKILL.md` in the
scenario work directory. This makes skill reference tests work across harness
conventions that use these two layouts without manually copying the instruction
file in each scenario.

`skill.referenced(...)` also recognizes Cursor's `.cursor/skills/<name>/SKILL.md`
layout, but automatic skill staging does not create it. Use fixtures or scenario
setup when a test specifically needs Cursor's native skill layout.

## Reusable Scenarios

Use `defineScenario` when you want to author or export a scenario
independently, then include it in a dyno.

```ts
import {command, defineDyno, defineScenario} from '@dynobox/sdk';

const checksPackageJson = defineScenario({
  name: 'checks package json',
  prompt: 'Use `cat package.json` and summarize the scripts.',
  assertions: [command.called('cat', {args: ['package.json']})],
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
      Use cat package.json and tell me whether this project has a test script.
    setup:
      - |
        cat > package.json <<'JSON'
        {"scripts":{"test":"vitest run"}}
        JSON
    assertions:
      - label: reads package.json
        type: command.called
        executable: cat
        command:
          args:
            - package.json
      - type: tool.notCalled
        tool: edit_file
      - type: artifact.contains
        path: package.json
        text: vitest run
      - type: finalMessage.contains
        text: test
```

YAML configs flow through the same schema and IR compiler as JavaScript and
TypeScript configs. YAML supports static and sequential CLI mocks. Function
handlers require a JavaScript or TypeScript config.

A static mock inside a YAML scenario uses this shape:

```yaml
cliMocks:
  vitest:
    response:
      exitCode: 0
      stdout: all tests passed
```

## Authoring Assertion Contract

All assertion objects accept optional `id` and `label` fields. `id` stabilizes
compiled assertion IDs and JSON report references. `label` appears in CLI and
JSON output.

| TypeScript helper                                      | Authoring object                                                      |
| ------------------------------------------------------ | --------------------------------------------------------------------- |
| `tool.called('shell', {includes: 'x'})`                | `{type: tool.called, tool: shell, command: {includes: x}}`            |
| `tool.called('read_file', {path: 'README.md'})`        | `{type: tool.called, tool: read_file, path: README.md}`               |
| `tool.notCalled('edit_file')`                          | `{type: tool.notCalled, tool: edit_file}`                             |
| `command.called('git', {args: ['status']})`            | `{type: command.called, executable: git, command: {args: [status]}}`  |
| `command.notCalled('git', {args: ['push']})`           | `{type: command.notCalled, executable: git, command: {args: [push]}}` |
| `verify.command('dynobox validate out.dyno.ts', {exitCode: 0})` | `{type: verify.command, command: dynobox validate out.dyno.ts, exitCode: 0}` |
| `artifact.exists('README.md')`                         | `{type: artifact.exists, path: README.md}`                            |
| `artifact.notExists('scratch.tmp')`                    | `{type: artifact.notExists, path: scratch.tmp}`                       |
| `artifact.contains('pkg.json', 'foo')`                 | `{type: artifact.contains, path: pkg.json, text: foo}`                |
| `artifact.unchanged('package-lock.json')`              | `{type: artifact.unchanged, path: package-lock.json}`                 |
| `transcript.contains('done')`                          | `{type: transcript.contains, text: done}`                             |
| `finalMessage.contains('ok')`                          | `{type: finalMessage.contains, text: ok}`                             |
| `skill.referenced('commit')`                           | `{type: skill.referenced, skill: commit}`                             |
| `anyOf([tool.called('read_file', {...}), ...])`         | `{type: anyOf, steps: [{type: tool.called, ...}, ...]}`               |
| `sequence.inOrder([command.called('git', {...}), ...])` | `{type: sequence.inOrder, steps: [{type: command.called, ...}, ...]}` |
| `http.called('npmPrettier', {status: 200})`            | `{type: http.called, endpoint: npmPrettier, status: 200}`             |
| `http.notCalled('leftPad')`                            | `{type: http.notCalled, endpoint: leftPad}`                           |

The optional assertion `id` field follows the same format as scenario IDs:
letters, numbers, dots, underscores, and hyphens.

Shell command matcher shapes accept exactly one of `equals`, `includes`,
`startsWith`, or `matches`, and are only valid on `shell` tool assertions.
Path matchers use a top-level `path` field and are only valid on file-oriented
tool assertions.

When YAML parsing fails, the CLI emits a `line:column` pointer into the file so
syntax errors are easy to locate.
