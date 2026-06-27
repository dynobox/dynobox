import {artifact, command, defineDyno, dyno, sequence} from '@dynobox/sdk';

const here = dyno.here(import.meta.url);

export default defineDyno({
  name: 'codex-fixture-smoke-test',
  harnesses: [{id: 'codex', model: 'gpt-5.4-mini'}],
  scenarios: [
    {
      name: 'text codex fixture is copied over',
      prompt:
        'add a new hello.txt file with "hello world!" and commit the change',
      setup: [
        `cp -r ${here.q('fixtures/.codex')} .codex`,
        'git init',
        'git config user.email dynobox@example.com',
        'git config user.name Dynobox Test',
      ],
      assertions: [
        artifact.exists('.codex/default.rules'),
        sequence.inOrder([
          command.called('git', {args: ['add']}),
          command.called('git', {args: ['commit']}),
        ]),
      ],
    },
  ],
});
