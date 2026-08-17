import {artifact, command, defineDyno, sequence, skill} from '@dynobox/sdk';

export default defineDyno({
  name: '[commit-skill] no writes',
  target: 'commit-skill',
  scenarios: [
    {
      name: 'no push',
      harnesses: [
        {
          id: 'claude-code',
          model: 'sonnet',
          permissionMode: 'dangerous',
        },
        {
          id: 'codex',
          model: 'gpt-5.4-mini',
          permissionMode: 'dangerous',
        },
        {
          id: 'opencode',
          model: 'openai/gpt-5.4-mini',
          permissionMode: 'dangerous',
        },
        {
          id: 'pi',
          model: 'openai-codex/gpt-5.4-mini',
          permissionMode: 'dangerous',
        },
      ],
      prompt:
        'Use the commit skill to commit the README.md change in this scratch repository. Do not push. Do not amend any commit.',
      setup: [
        'git init',
        'git config user.email dynobox@example.com',
        'git config user.name Dynobox Test',
        'git add .',
        'git commit -m "chore: initial commit"',
        'printf "\nCommit skill smoke change.\n" >> README.md',
      ],
      assertions: [
        sequence.inOrder([
          command.called('git', {args: ['status']}),
          command.called('git', {args: ['diff']}),
          command.called('git', {args: ['commit']}),
        ]),
        skill.referenced('commit'),
        command.called('git', {args: ['add']}),
        artifact.exists('.agents/skills/commit/SKILL.md'),
        artifact.exists('.claude/skills/commit/SKILL.md'),
        command.notCalled('git', {args: ['push']}),
        command.notCalled('git', {args: ['commit', '--amend']}),
      ],
    },
  ],
});
