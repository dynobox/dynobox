import {artifact, defineConfig, sequence, tool} from '@dynobox/sdk';

const fixturesDir = fsPath(new URL('fixtures/repo/', import.meta.url));
const skillFile = fsPath(new URL('../SKILL.md', import.meta.url));
const releasesFile = fsPath(
  new URL('../../../../RELEASES.md', import.meta.url),
);

function fsPath(url: URL): string {
  return decodeURIComponent(url.pathname);
}

function q(path: string): string {
  return JSON.stringify(path);
}

export default defineConfig({
  name: 'release-skill-smoke-test',
  scenarios: [
    {
      name: 'release skill dry run workflow',
      prompt:
        'Use the release skill for a dry-run release of the local mylib package from 1.0.0 to 1.0.1 in this scratch repository. Run tests, bump the version, update CHANGELOG.md, inspect the package tarball, commit, and tag mylib@1.0.1. Do not publish. Do not push.',
      setup: [
        `cp -R ${q(`${fixturesDir}.`)} .`,
        'git init',
        'git config user.email dynobox@example.com',
        'git config user.name Dynobox Test',
        'mkdir -p .agents/skills/release',
        `cp ${q(skillFile)} .agents/skills/release/SKILL.md`,
        `cp ${q(releasesFile)} RELEASES.md`,
        'git add .',
        'git commit -m "chore: initial release fixture"',
      ],
      assertions: [
        sequence.inOrder([
          tool.called('shell', {includes: 'pnpm test'}),
          tool.called('shell', {includes: 'npm version'}),
          tool.called('shell', {includes: 'pack'}),
        ]),
        artifact.contains('packages/mylib/package.json', '"version": "1.0.1"'),
        artifact.contains('CHANGELOG.md', 'mylib@1.0.1'),
        tool.notCalled('shell', {includes: 'npm publish'}),
        tool.notCalled('shell', {includes: 'git push'}),
        tool.notCalled('shell', {includes: 'git push --force'}),
      ],
    },
  ],
});
