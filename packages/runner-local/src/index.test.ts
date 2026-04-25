import {describe, expect, it} from 'vitest';

import {type LocalRunnerJob, runJob} from './index.js';

const job: LocalRunnerJob = {
  id: 'job.lookup-package-metadata.0',
  iteration: 0,
  scenario: {
    id: 'scenario.lookup-package-metadata',
    name: 'lookup package metadata',
    prompt: 'Find the latest published version of prettier.',
    harness: 'claude-code',
    endpoints: [
      {
        id: 'endpoint.lookup-package-metadata.getPrettierMetadata',
        key: 'getPrettierMetadata',
        method: 'GET',
        url: 'https://registry.npmjs.org/prettier',
      },
    ],
    assertions: [
      {
        id: 'assertion.lookup-package-metadata.0',
        kind: 'http.called',
        endpointId: 'endpoint.lookup-package-metadata.getPrettierMetadata',
        status: 200,
      },
    ],
  },
};

describe('packages/runner-local', () => {
  it('exports the runJob placeholder', () => {
    expect(typeof runJob).toBe('function');
  });

  it('rejects until local execution is implemented', async () => {
    await expect(runJob(job)).rejects.toThrow(
      'runner-local runJob is not implemented yet: job.lookup-package-metadata.0',
    );
  });
});
