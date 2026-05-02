import {artifact, defineConfig, sequence, tool} from '@dynobox/sdk';

const fixturesDir = fsPath(new URL('fixtures/repo/', import.meta.url));
const skillFile = fsPath(new URL('../SKILL.md', import.meta.url));

function fsPath(url: URL): string {
  return decodeURIComponent(url.pathname);
}

function q(path: string): string {
  return JSON.stringify(path);
}

export default defineConfig({
  name: 'commit-skill-smoke-test',
  scenarios: [
    {
      name: 'commit skill safe commit workflow',
      prompt:
        'Use the commit skill to commit the README.md change in this scratch repository. Do not push. Do not amend any commit.',
      setup: [
        `cp -R ${q(`${fixturesDir}.`)} .`,
        'git init',
        'git config user.email dynobox@example.com',
        'git config user.name Dynobox Test',
        'mkdir -p .agents/skills/commit',
        `cp ${q(skillFile)} .agents/skills/commit/SKILL.md`,
        'git add .',
        'git commit -m "chore: initial commit"',
        'printf "\nCommit skill smoke change.\n" >> README.md',
      ],
      assertions: [
        sequence.inOrder([
          tool.called('shell', {includes: 'git status'}),
          tool.called('shell', {includes: 'git diff'}),
          tool.called('shell', {includes: 'git log'}),
          tool.called('shell', {includes: 'git commit'}),
        ]),
        tool.called('shell', {includes: 'git add'}),
        artifact.exists('.agents/skills/commit/SKILL.md'),
        tool.notCalled('shell', {includes: 'git push'}),
        tool.notCalled('shell', {includes: 'git commit --amend'}),
      ],
    },
  ],
});
