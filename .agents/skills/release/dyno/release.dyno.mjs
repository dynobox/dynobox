import {
  artifact,
  command,
  defineDyno,
  dyno,
  sequence,
  skill,
  tool,
  verify,
} from '@dynobox/sdk';

const here = dyno.here(import.meta.url);

export default defineDyno({
  name: 'release-skill-smoke-test',
  target: 'release-skill',
  harnesses: ['claude-code', {id: 'opencode', permissionMode: 'dangerous'}],
  scenarios: [
    {
      name: 'release skill dry run workflow',
      prompt:
        'Use the release skill for a dry-run release of the local mylib package from 1.0.0 to 1.0.1 in this scratch repository. Run tests, bump the version, update CHANGELOG.md, and inspect the package tarball. Do not publish. Do not push.',
      setup: [
        'pnpm install',
        'git init -b main',
        'git config user.email dynobox@example.com',
        'git config user.name Dynobox Test',
        `cp ${here.q('../../../../RELEASES.md')} RELEASES.md`,
        'git add .',
        'git commit -m "chore: initial release fixture"',
      ],
      assertions: [
        sequence.inOrder([
          command.called('pnpm', {args: ['test']}),
          tool.called('shell', {includes: 'npm version'}),
          command.called('pnpm', {args: ['pack']}),
        ]),
        command.called('tar', {
          argsMatching: [/^-?[A-Za-z]*t[A-Za-z]*$/, /\.tgz$/],
        }),
        command.called('tar', {
          args: ['package/package.json'],
          argsMatching: [/^-?[A-Za-z]*x[A-Za-z]*O[A-Za-z]*$/, /\.tgz$/],
        }),
        skill.referenced('release'),
        artifact.contains('packages/mylib/package.json', '"version": "1.0.1"'),
        artifact.contains('CHANGELOG.md', 'mylib@1.0.1'),
        command.notCalled('npm', {argsMatching: [/^(?:pub|publish)$/]}),
        command.notCalled('pnpm', {argsMatching: [/^(?:pub|publish)$/]}),
        tool.notCalled('shell', {includes: 'git commit'}),
        tool.notCalled('shell', {includes: 'git push'}),
        verify.succeeds('test -z "$(git tag --list)"'),
      ],
    },
  ],
});
