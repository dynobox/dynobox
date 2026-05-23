import {defineDyno, dyno, finalMessage, skill, tool} from '@dynobox/sdk';

const here = dyno.here(import.meta.url);

export default defineDyno({
  name: 'dyno-debug-skill-smoke-test',
  scenarios: [
    {
      name: 'dyno-debug skill preserves matrix failure context',
      prompt:
        'Use the dyno-debug skill to investigate the failed Dynobox matrix run captured in matrix-failure-output.txt. I already ran the matrix with `--debug`; do not rerun Dynobox. Inspect the debug artifact paths before recommending a fix.',
      setup: [
        'mkdir -p .agents/skills/dyno-debug runs/codex-fail',
        `cp ${here.q('../SKILL.md')} .agents/skills/dyno-debug/SKILL.md`,
        'printf "assistant inspected README.md and stopped before editing\\n" > runs/codex-fail/dynobox-transcript.log',
        'printf "no harness stderr\\n" > runs/codex-fail/dynobox-stderr.log',
        'printf \'[{"type":"shell","command":"sed -n \\"1,80p\\" README.md"}]\\n\' > runs/codex-fail/dynobox-tool-events.json',
        'git init',
      ],
      assertions: [
        skill.invoked('dyno-debug'),
        tool.called('read_file', {path: 'matrix-failure-output.txt'}),
        tool.called('read_file', {
          path: 'runs/codex-fail/dynobox-transcript.log',
        }),
        tool.called('read_file', {path: 'runs/codex-fail/dynobox-stderr.log'}),
        tool.called('read_file', {
          path: 'runs/codex-fail/dynobox-tool-events.json',
        }),
        finalMessage.contains('Original run'),
        finalMessage.contains('Matrix signal'),
        finalMessage.contains('Failed job'),
        finalMessage.contains('claude-code'),
        finalMessage.contains('codex'),
        finalMessage.contains('artifact.contains'),
        finalMessage.contains(
          'does not invalidate the original matrix failure',
        ),
        tool.notCalled('shell', {includes: 'dynobox run'}),
      ],
    },
  ],
});
