import {defineDyno} from '@dynobox/sdk';
import {compile} from '@dynobox/sdk/compiler';
import {describe, expect, it} from 'vitest';

import {buildLocalRunnerJobs} from './jobs.js';

describe('buildLocalRunnerJobs', () => {
  it('rejects MCP scenarios before scheduling until an adapter is enabled', () => {
    const ir = compile(
      defineDyno({
        scenarios: [
          {
            name: 'MCP',
            prompt: 'Save',
            mcpMocks: {
              linear: {
                tools: {
                  save: {
                    inputSchema: {type: 'object'},
                    response: {content: []},
                  },
                },
              },
            },
          },
        ],
      }),
    );
    expect(() => buildLocalRunnerJobs(ir)).toThrow(
      'MCP mock execution is not enabled',
    );
    expect(buildLocalRunnerJobs(ir, {scenarioPatterns: ['unrelated']})).toEqual(
      [],
    );
  });
  it('expands jobs across scenario harnesses', () => {
    const jobs = buildLocalRunnerJobs({
      version: '0.4',
      scenarios: [
        {
          id: 'scenario.test',
          name: 'test',
          prompt: 'Run a test.',
          harnesses: [{id: 'claude-code'}, {id: 'codex', model: 'gpt-5'}],
          setup: [],
          fixtures: [],
          cliMocks: {},
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

  it('expands jobs across iterations', () => {
    const jobs = buildLocalRunnerJobs(
      {
        version: '0.4',
        scenarios: [
          {
            id: 'scenario.test',
            name: 'test',
            prompt: 'Run a test.',
            harnesses: [{id: 'claude-code'}],
            setup: [],
            fixtures: [],
            cliMocks: {},
            endpoints: [],
            assertions: [],
          },
        ],
      },
      {iterations: 3},
    );

    expect(jobs.map((job) => ({id: job.id, iteration: job.iteration}))).toEqual(
      [
        {id: 'scenario.test.claude-code.iteration.0', iteration: 0},
        {id: 'scenario.test.claude-code.iteration.1', iteration: 1},
        {id: 'scenario.test.claude-code.iteration.2', iteration: 2},
      ],
    );
  });

  it('preserves and overrides harness permission modes', () => {
    const ir = {
      version: '0.4' as const,
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
          cliMocks: {},
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

  it('preserves configured model and permission mode when selecting a harness', () => {
    const jobs = buildLocalRunnerJobs(
      {
        version: '0.4',
        scenarios: [
          {
            id: 'scenario.test',
            name: 'test',
            prompt: 'Run a test.',
            harnesses: [
              {id: 'claude-code'},
              {
                id: 'codex',
                model: 'gpt-5.4-mini',
                permissionMode: 'dangerous',
              },
            ],
            setup: [],
            fixtures: [],
            cliMocks: {},
            endpoints: [],
            assertions: [],
          },
        ],
      },
      {harnesses: [{id: 'codex'}]},
    );

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: 'scenario.test.codex.gpt-5.4-mini.dangerous.iteration.0',
      harness: 'codex',
      model: 'gpt-5.4-mini',
      permissionMode: 'dangerous',
    });
  });

  it('maps positional model overrides to selected harnesses', () => {
    const jobs = buildLocalRunnerJobs(
      {
        version: '0.4',
        scenarios: [
          {
            id: 'scenario.test',
            name: 'test',
            prompt: 'Run a test.',
            harnesses: [{id: 'claude-code'}, {id: 'codex'}],
            setup: [],
            fixtures: [],
            cliMocks: {},
            endpoints: [],
            assertions: [],
          },
        ],
      },
      {
        harnesses: [
          {id: 'claude-code', model: 'sonnet'},
          {id: 'codex', model: 'gpt-5.5'},
        ],
      },
    );

    expect(
      jobs.map((job) => ({harness: job.harness, model: job.model})),
    ).toEqual([
      {harness: 'claude-code', model: 'sonnet'},
      {harness: 'codex', model: 'gpt-5.5'},
    ]);
  });

  it('collapses duplicate configured harness ids when model is overridden', () => {
    const ir = {
      version: '0.4' as const,
      scenarios: [
        {
          id: 'scenario.test',
          name: 'test',
          prompt: 'Run a test.',
          harnesses: [
            {id: 'codex' as const, model: 'gpt-5.4-mini'},
            {id: 'codex' as const, model: 'gpt-5.5'},
          ],
          setup: [],
          fixtures: [],
          cliMocks: {},
          endpoints: [],
          assertions: [],
        },
      ],
    };

    expect(buildLocalRunnerJobs(ir, {harnesses: [{id: 'codex'}]})).toHaveLength(
      2,
    );
    expect(
      buildLocalRunnerJobs(ir, {
        harnesses: [{id: 'codex', model: 'gpt-5.6'}],
      }).map((job) => job.model),
    ).toEqual(['gpt-5.6']);
  });

  it('filters scenarios by exact name, id, and glob pattern', () => {
    const ir = {
      version: '0.4' as const,
      scenarios: [
        {
          id: 'scenario.lint-package',
          name: 'lint package',
          prompt: 'Run lint.',
          harnesses: [{id: 'claude-code' as const}],
          setup: [],
          fixtures: [],
          cliMocks: {},
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
          cliMocks: {},
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
          cliMocks: {},
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
      version: '0.4' as const,
      scenarios: [
        {
          id: 'dynobox-release.dyno.ts::scenario.release-notes',
          name: 'release notes',
          prompt: 'Write release notes.',
          harnesses: [{id: 'claude-code' as const}],
          setup: [],
          fixtures: [],
          cliMocks: {},
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
