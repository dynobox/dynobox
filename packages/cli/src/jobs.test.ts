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
          fixtures: [],
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
          fixtures: [],
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

  it('filters scenarios by exact name, id, and glob pattern', () => {
    const ir = {
      version: '0.1' as const,
      scenarios: [
        {
          id: 'scenario.lint-package',
          name: 'lint package',
          prompt: 'Run lint.',
          harnesses: [{id: 'claude-code' as const}],
          setup: [],
          fixtures: [],
          endpoints: [],
          assertions: [],
        },
        {
          id: 'scenario.deploy-package',
          name: 'deploy package',
          prompt: 'Run deploy.',
          harnesses: [{id: 'claude-code' as const}],
          setup: [],
          fixtures: [],
          endpoints: [],
          assertions: [],
        },
        {
          id: 'scenario.release-notes',
          name: 'release notes',
          prompt: 'Write release notes.',
          harnesses: [{id: 'claude-code' as const}],
          setup: [],
          fixtures: [],
          endpoints: [],
          assertions: [],
        },
      ],
    };

    expect(
      buildLocalRunnerJobs(ir, {scenarioPatterns: ['deploy package']}).map(
        (job) => job.scenario.name,
      ),
    ).toEqual(['deploy package']);
    expect(
      buildLocalRunnerJobs(ir, {
        scenarioPatterns: ['scenario.release-notes'],
      }).map((job) => job.scenario.name),
    ).toEqual(['release notes']);
    expect(
      buildLocalRunnerJobs(ir, {
        scenarioPatterns: ['release-notes'],
      }).map((job) => job.scenario.name),
    ).toEqual(['release notes']);
    expect(
      buildLocalRunnerJobs(ir, {scenarioPatterns: ['*package']}).map(
        (job) => job.scenario.name,
      ),
    ).toEqual(['lint package', 'deploy package']);
  });

  it('filters source-prefixed scenario ids by authored id suffixes', () => {
    const ir = {
      version: '0.1' as const,
      scenarios: [
        {
          id: 'dynobox-release.dyno.ts::scenario.release-notes',
          name: 'release notes',
          prompt: 'Write release notes.',
          harnesses: [{id: 'claude-code' as const}],
          setup: [],
          fixtures: [],
          endpoints: [],
          assertions: [],
        },
      ],
    };

    expect(
      buildLocalRunnerJobs(ir, {
        scenarioPatterns: ['release-notes'],
      }).map((job) => job.scenario.name),
    ).toEqual(['release notes']);
    expect(
      buildLocalRunnerJobs(ir, {
        scenarioPatterns: ['scenario.release-notes'],
      }).map((job) => job.scenario.name),
    ).toEqual(['release notes']);
  });
});
