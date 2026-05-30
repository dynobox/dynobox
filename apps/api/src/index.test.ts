import {afterEach, describe, expect, it, vi} from 'vitest';

import {app} from './index.js';
import {createTestEnv, type TokenRow} from './test-support.js';

describe('api worker', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

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

  it('registers run API routes as explicit placeholders', async () => {
    const response = await app.request('/runs', {method: 'POST'});

    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'not_implemented',
        message: 'Run upload is not implemented yet.',
      },
    });
    expect(response.status).toBe(501);
  });

  it('mints CLI tokens for authenticated browser identities', async () => {
    vi.stubGlobal('fetch', async () => Response.json({id: 'user-123'}));

    const rows: TokenRow[] = [];
    const response = await app.request(
      '/cli-tokens',
      {
        headers: {
          authorization: 'Bearer supabase-token',
        },
        method: 'POST',
      },
      createTestEnv(rows),
    );

    const body = (await response.json()) as {token: string};

    expect(response.status).toBe(201);
    expect(body.token).toMatch(/^dyno_[A-Za-z0-9_-]{43}$/);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: 'supabase',
      subject_id: 'user-123',
    });
    expect(rows[0]?.token_hash).not.toBe(body.token);
  });

  it('rejects unauthenticated CLI token minting', async () => {
    const response = await app.request(
      '/cli-tokens',
      {method: 'POST'},
      createTestEnv(),
    );

    await expect(response.json()).resolves.toEqual({
      error: {code: 'unauthorized', message: 'Authentication required.'},
    });
    expect(response.status).toBe(401);
  });
});
