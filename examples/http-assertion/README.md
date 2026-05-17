# HTTP Assertion Example

Demonstrates `http.called` and `http.notCalled` assertions against declared
endpoints.

HTTP capture uses proxy environment variables, so this example works when
the agent uses local child-process tools such as `curl`, Python `requests`,
or env-aware Node HTTP clients. Built-in harness web tools may bypass the
local proxy.

```bash
node packages/cli/dist/bin.js run examples/http-assertion/http-assertion.dyno.mjs
node packages/cli/dist/bin.js run examples/http-assertion/http-assertion.dyno.yaml
```
