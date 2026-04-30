import {defineConfig, tool} from '@dynobox/sdk';

export default defineConfig({
  name: 'local-observability',
  scenarios: [
    {
      name: 'inspect package scripts',
      prompt:
        'Use a shell command that reads package.json and tell me whether a test script exists.',
      setup: [
        `cat > package.json <<'JSON'
{
  "name": "dynobox-local-smoke",
  "scripts": {
    "test": "vitest run"
  }
}
JSON`,
      ],
      assertions: [
        tool.called('shell'),
        tool.called('shell', {includes: 'package.json'}),
      ],
    },
  ],
});
