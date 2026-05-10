import {describe, expect, it} from 'vitest';

import {buildLocalRunnerJobs} from './jobs.js';

describe('buildLocalRunnerJobs', () => {
  it('expands jobs across scenario harnesses', () => {
    const jobs = buildLocalRunnerJobs({
      version: '0.1',
      scenarios: [
        {
          id: 'scenario.test',
          name: 'test',
          prompt: 'Run a test.',
          harnesses: [{id: 'claude-code'}, {id: 'codex', model: 'gpt-5'}],
          setup: [],
          endpoints: [],
          assertions: [],
        },
      ],
    });

    expect(jobs.map((job) => ({id: job.id, harness: job.harness}))).toEqual([
      {id: 'scenario.test.claude-code.iteration.0', harness: 'claude-code'},
      {id: 'scenario.test.codex.gpt-5.iteration.0', harness: 'codex'},
    ]);
  });

  it('preserves and overrides harness permission modes', () => {
    const ir = {
      version: '0.1' as const,
      scenarios: [
        {
          id: 'scenario.test',
          name: 'test',
          prompt: 'Run a test.',
          harnesses: [
            {id: 'codex' as const, permissionMode: 'dangerous' as const},
          ],
          setup: [],
          endpoints: [],
          assertions: [],
        },
      ],
    };

    expect(buildLocalRunnerJobs(ir)[0]).toMatchObject({
      id: 'scenario.test.codex.dangerous.iteration.0',
      permissionMode: 'dangerous',
    });
    expect(
      buildLocalRunnerJobs(ir, {permissionMode: 'default'})[0],
    ).toMatchObject({
      id: 'scenario.test.codex.default.iteration.0',
      permissionMode: 'default',
    });
  });
});
