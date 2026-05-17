# NPM Package Research Example

Demonstrates **HTTP endpoint declarations** in the Dynobox config and
assertions that an agent did or did not call specific URLs.

HTTP capture uses a local proxy, so it covers local child-process tools
that honor proxy environment variables. Harness-native web tools may not
flow through the proxy.

## Run

```bash
node packages/cli/dist/bin.js run examples/npm-package-research/npm-research.dyno.mjs
```

The CLI compiles the file, runs the scenarios, captures matching HTTP
traffic, and evaluates the `http.called` / `http.notCalled` assertions.
