import {describe, expect, it} from 'vitest';

import {app} from './index.js';

describe('api worker', () => {
  it('returns health status', async () => {
    const response = await app.request('/health');

    await expect(response.json()).resolves.toEqual({ok: true});
    expect(response.status).toBe(200);
  });

  it('returns JSON errors for unknown routes', async () => {
    const response = await app.request('/missing');

    await expect(response.json()).resolves.toEqual({
      error: {code: 'not_found', message: 'Route not found.'},
    });
    expect(response.status).toBe(404);
  });

  it('registers initial API routes as explicit placeholders', async () => {
    const response = await app.request('/runs', {method: 'POST'});

    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'not_implemented',
        message: 'Run upload is not implemented yet.',
      },
    });
    expect(response.status).toBe(501);
  });
});
