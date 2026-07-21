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
- [`.agents/skills/commit/dyno/commit.dyno.mjs`](https://github.com/dynobox/skills/blob/main/.agents/skills/commit/dyno/commit.dyno.mjs)

## Pattern

The current example uses one GitHub Actions job and lets Dynobox expand the
matrix defined by the dyno files:

```bash
npx dynobox run .agents/skills --reporter json > dynobox.ndjson
```

This shape is useful for skill repositories because each skill can own its tests
under `.agents/skills/<skill-name>/dyno`, while CI only needs to point Dynobox at
`.agents/skills`.

The workflow in `dynobox/skills` does the following:

- Checks out the repository with persisted Git credentials disabled.
- Installs Node.js dependencies and the local agent harness CLIs.
- Verifies `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are available.
- Logs Codex in with `codex login --with-api-key`.
- Runs `dynobox run .agents/skills --reporter json` once.
- Writes the NDJSON report to `dynobox.ndjson`.
- Converts the final `summary` record and failed job diagnostics into
  `dynobox.md`.
- Appends that Markdown to the GitHub step summary.
- Optionally upserts a PR comment for same-repository pull requests.
- Uploads `dynobox.ndjson` and `dynobox.md` as workflow artifacts.
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

This keeps local and CI runs aligned. The same `dynobox run .agents/skills`
command discovers every skill dyno and executes the configured scenario/harness
pairs.

## Required Secrets

The current example expects these repository secrets:

- `ANTHROPIC_API_KEY` for Claude Code runs.
- `OPENAI_API_KEY` for Codex runs.

OpenCode runs require the `opencode` executable plus credentials for the
provider named by the configured `provider/model`. OpenCode has no single
provider-independent CI secret.

If your dynos only use one harness, adjust the setup and secret checks to match
the harnesses you actually run.

## Status

This pattern is a practical starting point for teams that want Dynobox in CI
today. Future Dynobox releases may provide a smaller packaged action or a
different hosted reporting path, so treat the skills repo workflow as an example
rather than a stable final interface.
