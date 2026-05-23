# CI Integration

Dynobox runs in CI like any other command-line test step. A successful run exits
with `0`; config, flag, discovery, load, or job failures exit with `1`.

Use text output when humans will read the log:

```bash
dynobox run dynobox --quiet --harness claude-code
```

Use JSON output when a later CI step should consume the results:

```bash
dynobox run dynobox --reporter json --harness claude-code > dynobox-report.ndjson
```

`--reporter json` writes newline-delimited JSON to stdout. Each completed job
produces one `"type": "job"` record, followed by one `"type": "summary"` record.
Every record includes `"schema": "dynobox.report.v1"`.

## Recommended Pattern

1. Install Node.js 22 or newer.
2. Install `dynobox`.
3. Install the harness executable for the job.
4. Run `dynobox run` once per harness, usually through a CI matrix.
5. Upload the JSON report as a build artifact.
6. Summarize the final JSON `summary` record in the job output.

For targeted CI jobs, combine the JSON reporter with scenario filters:

```bash
dynobox run dynobox --reporter json --scenario "release*" > dynobox-report.ndjson
```

Scenario filters match the compiled scenario name or id. Authored scenario IDs
can be matched with or without the `scenario.` prefix, even when JSON job IDs
are source-prefixed during multi-file discovery. Repeat the flag or use
comma-separated values to select multiple patterns:

```bash
dynobox run dynobox --scenario "release*,publish package"
```

## GitHub Actions

A reference workflow lives at
[`examples/.github/workflows/example-eval.yml`](../examples/.github/workflows/example-eval.yml).
It runs a matrix over `claude-code` and `codex`, writes one NDJSON report per
harness, uploads each report, and appends a compact summary to the GitHub
Actions step summary.

Copy the workflow into your repository's `.github/workflows/` directory and
adjust:

- `DYNOBOX_TARGET` for the directory or file containing your dynos.
- Harness install commands for your pinned versions.
- Secrets for the selected harnesses.

The example assumes:

- `ANTHROPIC_API_KEY` is available for `claude-code`.
- `OPENAI_API_KEY` is available for `codex`.

## Read JSON Reports

The JSON reporter is line-oriented. Read the file one line at a time and parse
each line as a separate JSON object.

```js
import {readFileSync} from 'node:fs';

const records = readFileSync('dynobox-report.ndjson', 'utf8')
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const summary = records.find((record) => record.type === 'summary');
console.log(summary.totals);
```

Useful job fields include `jobId`, `scenario`, `harness`, `status`, `passed`,
`warnings`, `observations`, and `assertions`.

Useful summary fields include `status`, `totals`, `plan`, `failedJobs`, and
`warningJobs`.

Permission warnings are advisory. They explain when a harness blocked a tool
action, but they do not change job status or exit codes. Use
`--permission-mode dangerous` only for trusted evals that intentionally need
full local access.

Config and discovery failures can happen before any job runs. In those cases,
Dynobox writes the config error to stderr and exits `1`; there may be no JSON
summary record to parse.

## Artifact Naming

When a CI matrix runs multiple harnesses, write one report per harness:

```bash
dynobox run dynobox --reporter json --harness "$HARNESS" > "dynobox-${HARNESS}.ndjson"
```

This keeps reports easy to compare and avoids interleaving records from
different CI jobs.
