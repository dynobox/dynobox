# How It Works

Dynobox tests agent workflows by recording observable behavior and evaluating
explicit assertions against that evidence. It does not ask another model to
decide whether the agent did a good job.

Each scenario, harness, and iteration becomes a separate job with this
lifecycle:

```text
fresh work directory
  -> fixtures and setup
  -> optional CLI mock shims are installed
  -> harness runs under observation and mock calls are recorded
  -> evidence is captured
  -> observation assertions evaluate harness-phase evidence
  -> verification assertions run
  -> pass or fail with recorded results
```

## 1. Start With A Fresh Work Directory

Dynobox creates a new temporary work directory for every job. The selected
harness runs with that directory as its working directory, and file assertions
are scoped to paths inside it. Separate harnesses and repeated iterations do not
share job files.

The work directory provides file separation, not a security sandbox. Dynos are
trusted code: JavaScript and TypeScript configs are imported, and setup,
verification, and harness processes can access the host according to their
normal permissions.

## 2. Build The Fixture

Dynobox copies configured fixture directories into the work directory, then
runs setup commands there in order. A failed fixture copy or setup command stops
the job before the harness starts and records a `setup_failed` result with the
setup logs.

After setup succeeds, Dynobox fingerprints files used by
`artifact.unchanged(...)`. This creates the pre-harness baseline that will be
compared with the completed work later.

See [Config Authoring](./config-authoring.md#scenarios) for fixture and setup
options.

## 3. Run The Harness Under Observation

Dynobox launches the configured harness executable with the scenario prompt and
temporary work directory. The harness still uses its own installed version,
authentication, model configuration, permission rules, and sandbox behavior.
Dynobox controls the test lifecycle around it rather than replacing the harness
runtime.

When a scenario configures experimental CLI mocks, Dynobox prepends generated
shims to the harness process's `PATH`. Bare executable calls from the harness or
its child processes can then receive configured static, sequential, or
handler-based responses. Shell startup hooks keep the shim directory ahead of
profile-modified paths. For Codex jobs with CLI mocks, Dynobox disables login
shell execution and shell snapshots so Codex cannot restore a profile-captured
`PATH` over the shims. Setup commands and harness version detection use the real
`PATH`. Explicit executable paths and commands that do not use `PATH` lookup can
bypass the shims, so CLI mocking is a behavioral test double rather than a
sandbox.

While the process runs, the harness adapter reads its structured output and
emits tool events. After the process exits, the adapter extracts the complete
transcript, final assistant message, tool events, exit code, stderr, and timing.
A process or extraction failure produces a `harness_failed` result instead of
running assertions against incomplete output.

## 4. Capture Observable Evidence

Dynobox assembles several evidence sources from the harness run:

- **Tool events:** harness-specific tool names and inputs are retained and also
  mapped to common tool kinds such as shell, file read, and file edit where
  possible.
- **Normalized commands:** shell tool events are split into command segments and
  normalized into executable and argument data. Assertions can use that
  structure instead of matching an entire raw shell string.
- **CLI mock calls:** experimental CLI mocks record the executable, arguments,
  working directory, timestamp, response, and exit code. Child environment
  values supplied to a handler are not retained in the call record.
- **Artifacts:** file assertions inspect the final state of the temporary work
  directory. Unchanged checks compare final bytes with the baseline captured
  after fixtures and setup.
- **Transcript and final message:** text assertions can inspect either the full
  harness transcript or the extracted final assistant response.
- **HTTP events:** when a scenario has HTTP assertions, Dynobox starts a local
  per-job proxy and gives the harness child process proxy environment variables.
  A generated local CA, exposed through common CA environment variables, lets
  compatible child-process clients make HTTPS requests through that proxy.

HTTP capture is intentionally scoped. It observes child-process traffic that
honors the proxy and CA environment variables; it is not system-wide packet
capture. Harness-native web tools and binaries with independent proxy or trust
configuration may bypass it.

Command normalization also has documented parsing limits. Raw shell text is
retained for diagnostics, but constructs such as `eval`, command substitution,
and deeply nested wrappers may not produce the normalized command an assertion
expects. See the [command assertion limits](./config-authoring.md#commands) and
the [HTTP assertion
limits](./config-authoring.md#http-assertions) for details.

## 5. Evaluate Assertions

After a successful harness run, Dynobox evaluates each authored assertion
against the captured evidence:

- `tool.*`, `command.*`, `sequence.*`, and `skill.*` inspect observed tool and
  command events.
- `artifact.*` inspects the completed work directory and captured baselines.
- `http.*` inspects proxy-observed requests and responses.
- `transcript.*` and `finalMessage.*` inspect recorded text.
- `verify.command(...)` runs an explicit post-harness command in the completed
  work directory and checks its exit code or output.

Observation assertions are evaluated before verification commands can mutate
the work directory. Command and sequence assertions use CLI mock calls captured
through the end of the harness phase; later verification calls remain in local
reporting but cannot satisfy those assertions. Mock sequence exhaustion, handler
errors or timeouts, and unfinished calls fail the job as lifecycle errors. Every
assertion receives its own result and evidence; the job passes only when every
assertion passes.

See the [assertion reference](./config-authoring.md#assertions) for all matchers.

## 6. Report The Result And Evidence

The final job status distinguishes a passing run from setup, harness, and
assertion failures. Terminal output shows failed expectations and matched or
observed evidence. `--verbose` expands lifecycle details, while `--debug` also
prints work-directory and artifact paths and writes available transcript, chat
history, tool-event, CLI mock-call, and stderr logs into the job directory.

For automation, `--reporter json` returns the structured job and assertion
results. `--save-run` can upload a compact, length-capped summary to the
authenticated Dynobox dashboard or an unauthenticated custom
`DYNOBOX_UPLOAD_URL` endpoint. Uploads include available Git revision and
identity metadata from the directory where the CLI was started. Saved data is
not redacted, so do not upload runs whose evidence may contain secrets.

See [Getting Started](./getting-started.md#debug-a-run) for local debugging and
the [CLI Reference](./cli.md#output-modes) for reporter details.
