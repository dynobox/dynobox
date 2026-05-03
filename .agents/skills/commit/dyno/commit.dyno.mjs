import {artifact, defineConfig, dyno, sequence, tool} from '@dynobox/sdk';

const here = dyno.here(import.meta.url);

export default defineConfig({
  name: 'commit-skill-smoke-test',
  scenarios: [
    {
      name: 'commit skill safe commit workflow',
      prompt:
        'Use the commit skill to commit the README.md change in this scratch repository. Do not push. Do not amend any commit.',
      setup: [
        `cp -R ${here.q('fixtures/repo/.')} .`,
        `cp -r ${here.q('fixtures/.codex/')} ./`,
        'git init',
        'git config user.email dynobox@example.com',
        'git config user.name Dynobox Test',
        'mkdir -p .agents/skills/commit',
        `cp ${here.q('../SKILL.md')} .agents/skills/commit/SKILL.md`,
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
