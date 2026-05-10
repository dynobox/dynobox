# NPM Package Research Example

Demonstrates **HTTP endpoint declarations** in the Dynobox config — the
shape an author would use to assert that an agent did (or did not) call
specific URLs.

> ⚠ **Heads up:** HTTP capture is not yet wired into the local runner.
> The endpoints and `http.called`/`http.notCalled` assertions in this
> file are author-facing only. They compile through the SDK and produce
> IR, but the local runner currently reports `http.*` assertions as
> "unsupported" rather than evaluating them.
>
> This example is kept in the repo so you can see the intended authoring
> shape ahead of HTTP capture landing.

## Run (for shape only)

```bash
node packages/cli/dist/bin.js run examples/npm-package-research/npm-research.dyno.mjs
```

The CLI will compile the file and attempt the scenarios, but every
`http.*` assertion will fail with `not yet implemented` until the
mitmproxy-backed capture layer is wired up.

Track progress in [`docs/README.md`](../../docs/README.md) under
"Not Yet Covered."
