import {command, defineDyno, finalMessage} from '@dynobox/sdk';

export default defineDyno({
  name: 'local-observability',
  harnesses: [{id: 'claude-code', permissionMode: 'default'}],
  scenarios: [
    {
      name: 'inspect package scripts',
      prompt:
        'Use `cat package.json` and tell me whether a test script exists.',
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
        command.called('cat', {args: ['package.json']}),
        finalMessage.contains('test'),
      ],
    },
  ],
});
