import {artifact, defineDyno, finalMessage, tool} from '@dynobox/sdk';

/**
 * Sibling of `inspect-package.dyno.mjs`. Together they demonstrate that
 * `dynobox run examples/local-observability` discovers and runs every
 * authored `*.dyno.mjs` in the directory.
 *
 * This example exercises a write/edit and so opts into `permissionMode:
 * 'dangerous'`. That mode adds `--permission-mode bypassPermissions` for
 * Claude Code and `--sandbox danger-full-access -c approval_policy="never"`
 * for Codex. Use it only for trusted local evals.
 */
export default defineDyno({
  name: 'add-script',
  harnesses: [{id: 'claude-code', permissionMode: 'dangerous'}],
  scenarios: [
    {
      name: 'adds a lint script',
      prompt:
        'Edit package.json to add a "lint" script that runs `echo lint ok`. Use a shell command to write the file.',
      setup: [
        `cat > package.json <<'JSON'
{
  "name": "dynobox-add-script-fixture",
  "scripts": {
    "test": "vitest run"
  }
}
JSON`,
      ],
      assertions: [
        tool.called('shell'),
        artifact.contains('package.json', 'lint'),
        artifact.contains('package.json', 'echo lint ok'),
        finalMessage.contains('lint'),
      ],
    },
  ],
});
