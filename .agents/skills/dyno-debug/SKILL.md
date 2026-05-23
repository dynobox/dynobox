---
name: dyno-debug
description: |
  Debug failed Dynobox runs from the public dynobox CLI package, especially
  matrix runs where the same scenario behaves differently across harnesses,
  models, or iterations. Use this skill when investigating dynobox run failures,
  flaky agent behavior, failed assertions, missing tool calls, debug artifacts,
  work directories, transcripts, or when deciding whether to rerun individual
  jobs versus preserving the original matrix result.
---

# Dyno Debug

This skill investigates Dynobox failures without losing the original run signal.
Assume `dynobox` is the installed public CLI package unless the user explicitly
says they are debugging the local Dynobox repository.

Treat a matrix run as evidence: rerunning one failed job can be useful, but it
can also erase the cross-harness behavior that made the failure important.

## First Response

Before rerunning anything, capture the original result:

```bash
dynobox run <path> --debug
```

If the user already provided output, summarize:

- scenario, harness, model, iteration, and status
- failed assertions and expected order/content
- observed tool commands
- work directories and debug artifact paths, if present
- which jobs passed in the same matrix

Call out cross-harness differences explicitly. For example, "Claude passed and
Codex failed in the same run" is usually more important than the isolated
assertion failure.

## Preserve Matrix Context

Do not treat isolated reruns as a replacement for the original matrix result.
Record both:

- original matrix outcome
- isolated rerun outcome

If an isolated rerun passes after a matrix failure, report it as nondeterminism
or run-context sensitivity unless evidence points to a deterministic bug.

Useful language:

```text
The rerun passed, but that does not invalidate the original matrix failure.
The original run captured a same-scenario, cross-harness difference that should
be preserved as a first-class debugging artifact.
```

## Inspect Artifacts

When `--debug` output includes paths, inspect these first:

```bash
sed -n '1,240p' <work-dir>/dynobox-transcript.log
sed -n '1,240p' <work-dir>/dynobox-stderr.log
sed -n '1,240p' <work-dir>/dynobox-tool-events.json
git -C <work-dir> status --short
```

For artifact assertions, inspect the actual workdir file:

```bash
sed -n '1,220p' <work-dir>/<artifact-path>
```

For sequence assertions, compare expected tool order against normalized tool
events, not only the terminal summary.

## Rerun Carefully

Prefer rerunning the same matrix first:

```bash
dynobox run <path> --debug
```

Then narrow only after recording the matrix result:

```bash
dynobox run <path> --scenario "<pattern>" --debug
dynobox run <path> --harness <id> --scenario "<pattern>" --debug
```

If the original failure used a configured model, avoid accidentally changing it.
Using `--harness codex` may drop a model declared in the dyno config. To preserve
the exact model, prefer `--scenario` without `--harness`, or create a temporary
dyno config that pins the same harness config.

## Local Repo Exception

Only use local source commands when the user explicitly says they are debugging
Dynobox itself or asks to run against a local build:

```bash
pnpm build
node packages/cli/dist/bin.js run <path> --debug
```

Otherwise, keep examples and recommendations on the public CLI:

```bash
dynobox run <path> --debug
```

## Common Failure Patterns

### Harness stopped before mutation

Symptoms:

- setup passed
- harness ran tools
- artifact did not change
- expected mutation command is absent

Check whether the agent stopped after inspection, hit a policy/tool permission
issue, or gave a final answer without completing the requested workflow.

### Sequence too strict

Symptoms:

- the workflow succeeded
- assertion fails because the harness combined commands or used equivalent
  commands in a different order

Prefer behavioral assertions where possible:

- required final artifact exists or contains expected content
- forbidden destructive commands were not called
- at least one relevant verification command ran
- commit/tag/publish safety rules were respected

Keep sequence assertions for workflows where order is the product behavior.

### Matrix-only failure

Symptoms:

- a job fails in a full matrix
- the same job passes when rerun alone

Preserve the original matrix result and mark the issue as nondeterministic or
context-sensitive. Do not conclude "no bug" from the isolated pass.

## Reporting

End with a concise debugging record:

```markdown
## Dynobox Debug Record

- Original run:
- Matrix signal:
- Failed job:
- Failed assertions:
- Observed tools:
- Workdir/artifacts:
- Rerun result:
- Likely cause:
- Recommended next change:
```

When the evidence points to a product gap, suggest recording matrix runs as
first-class artifacts, with one top-level run id and per-job child artifacts.
