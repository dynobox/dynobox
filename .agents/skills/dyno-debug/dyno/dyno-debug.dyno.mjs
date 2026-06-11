import {defineDyno, finalMessage, skill, tool} from '@dynobox/sdk';

export default defineDyno({
  name: 'dyno-debug-skill-smoke-test',
  target: 'dyno-debug-skill',
  scenarios: [
    {
      name: 'dyno-debug skill preserves matrix failure context',
      prompt:
        'Use the dyno-debug skill to investigate the failed Dynobox matrix run captured in matrix-failure-output.txt. I already ran the matrix with `--debug`; do not rerun Dynobox. Inspect the debug artifact paths before recommending a fix.',
      setup: [
        'mkdir -p runs/failed-job',
        'printf "assistant inspected README.md and stopped before editing\\n" > runs/failed-job/dynobox-transcript.log',
        'printf "no harness stderr\\n" > runs/failed-job/dynobox-stderr.log',
        'printf \'[{"type":"shell","command":"sed -n \\"1,80p\\" README.md"}]\\n\' > runs/failed-job/dynobox-tool-events.json',
        'git init',
      ],
      assertions: [
        skill.invoked('dyno-debug'),
        tool.called('read_file', {path: 'matrix-failure-output.txt'}),
        tool.called('read_file', {
          path: 'runs/failed-job/dynobox-transcript.log',
        }),
        tool.called('read_file', {path: 'runs/failed-job/dynobox-stderr.log'}),
        tool.called('read_file', {
          path: 'runs/failed-job/dynobox-tool-events.json',
        }),
        finalMessage.contains('Original run'),
        finalMessage.contains('Matrix signal'),
        finalMessage.contains('Failed job'),
        finalMessage.contains('artifact.contains'),
        tool.notCalled('shell', {includes: 'dynobox run'}),
      ],
    },
  ],
});
