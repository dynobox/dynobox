# CI Integration

CI support is usable today, but the final Dynobox CI experience is still
evolving. Dynobox does not ship a packaged GitHub Action yet. Until then,
[`dynobox/skills`](https://github.com/dynobox/skills) provides a temporary
working pattern you can inspect and adapt.

The skills repo is intentionally a first look, not the final CI contract. It
shows how to run real skill dynos in GitHub Actions, publish a readable summary,
and preserve the original Dynobox exit status after reporting artifacts are
created.

## Reference Implementation

See these files in [`dynobox/skills`](https://github.com/dynobox/skills):

- [`.github/workflows/dynobox.yml`](https://github.com/dynobox/skills/blob/main/.github/workflows/dynobox.yml)
- [`.github/actions/run-dynobox/action.yml`](https://github.com/dynobox/skills/blob/main/.github/actions/run-dynobox/action.yml)
- [`skills/dyno-from-skill/dyno/dyno-from-skill.dyno.mjs`](https://github.com/dynobox/skills/blob/main/skills/dyno-from-skill/dyno/dyno-from-skill.dyno.mjs)

## Pattern

The current example uses one GitHub Actions job and lets Dynobox expand the
matrix defined by the dyno files:

```bash
npx dynobox run skills --debug --reporter json > dynobox.ndjson
```

This shape is useful for skill repositories because each skill can own its tests
under `skills/<skill-name>/dyno`, while CI only needs to point Dynobox at
`skills`.

## Trust Boundary

Dynos and their setup or verification commands execute as trusted code. Do not
make model credentials available to a job that checks out and runs untrusted
pull-request content. Fork pull requests do not receive repository secrets by
default, but same-repository pull requests can still expose secrets to code in
the branch.

Run secret-bearing evals only from trusted refs such as protected branch pushes,
manual workflows with environment approval, or a base-revision checkout that
does not execute pull-request-authored dynos. Use `permissions: contents: read`
unless the reporting steps require additional access, and set
`persist-credentials: false` on checkout.

Treat JSON reports and `--debug` artifacts as sensitive. Transcripts, chat
history, tool events, stderr, prompts, source content, and command output are not
redacted. Limit artifact access and retention, and do not upload them from runs
that may contain secrets.

The workflow in `dynobox/skills` does the following:

- Checks out the repository with persisted Git credentials disabled.
- Installs Node.js dependencies and the local agent harness CLIs.
- Verifies `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are available.
- Passes `ANTHROPIC_API_KEY` to Claude Code and `CODEX_API_KEY` to Codex.
- Runs `dynobox run skills --debug --reporter json` once.
- Writes the NDJSON report to `dynobox.ndjson`.
- Converts the final `summary` record and failed job diagnostics into
  `dynobox.md`.
- Appends that Markdown to the GitHub step summary.
- Automatically upserts a report comment for same-repository pull requests.
  These runs execute checked-out PR dynos with model credentials, so
  contributor-facing repositories must add an approval boundary before adopting
  this trigger.
- Uploads `dynobox.ndjson`, `dynobox.md`, and available debug logs as workflow
  artifacts.
- Fails the job with Dynobox's original exit status after reporting finishes.

## Harness Matrix

The GitHub Actions workflow does not duplicate the harness matrix. The dyno file
owns it instead:

```js
const harnesses = [
  {
    id: 'claude-code',
    model: 'sonnet',
  },
  {
    id: 'codex',
    model: 'gpt-5.4-mini',
    permissionMode: 'dangerous',
  },
];

export default defineDyno({
  name: 'commit-skill-smoke-test',
  harnesses,
  scenarios: [
    // ...
  ],
});
```

This keeps local and CI runs aligned. The same `dynobox run .agents/skills` command
discovers every project scoped skill dyno and executes the configured scenario/harness
pairs.

## Required Secrets

The current example expects these repository secrets:

- `ANTHROPIC_API_KEY` for Claude Code runs.
- `OPENAI_API_KEY` for Codex runs.

OpenCode runs require the `opencode` executable plus credentials for the
provider named by the configured `provider/model`. OpenCode has no single
provider-independent CI secret.

Pi likewise has no provider-independent Dynobox secret. Install and configure
`pi`, then provide the credential required by the selected `provider/model`.
The example workflow remains a Claude Code and Codex example unless its install,
configuration, and secret steps are extended for another harness.

Cursor CLI runs should accept a `CURSOR_API_KEY` repository secret if you want
to run that harness in CI. Locally, a prior `cursor-agent login` session also
works.

Google Antigravity CLI runs require `agy` 1.1.14 or newer. For unattended CI,
store a Gemini API key as `GEMINI_API_KEY` and create
`~/.gemini/antigravity-cli/settings.json` with:

```json
{
  "modelProvider": "gemini"
}
```

Antigravity does not select API-key authentication from `GEMINI_API_KEY` alone.
With the provider setting present it skips account sign-in, so CI does not need
to copy an interactive login or keyring cache.

If your dynos only use one harness, adjust the setup and secret checks to match
the harnesses you actually run.
