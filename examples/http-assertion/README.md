# HTTP Assertion Example

Demonstrates `command.called`, `http.called`, and `http.notCalled` assertions
against declared endpoints.

HTTP capture uses proxy environment variables, so this example works when
the agent uses local child-process tools such as `curl`, Python `requests`,
or env-aware Node HTTP clients. Built-in harness web tools may bypass the
local proxy.

The examples assert both the observed agent action and the captured network
effect:

- `command.called('curl', {args: ['https://httpbin.org/status/204']})` checks
  that the agent ran the requested CLI command.
- `http.called('getHttpBinStatus', {status: 204})` checks that Dynobox observed
  the expected HTTP request and response.
- `http.notCalled('getHttpBinAnything')` checks that the unrelated endpoint was
  not requested.

```bash
npx dynobox run examples/http-assertion/http-assertion.dyno.mjs
npx dynobox run examples/http-assertion/http-assertion.dyno.yaml
```
