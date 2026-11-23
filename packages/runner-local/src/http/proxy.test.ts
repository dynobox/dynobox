import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import type {HttpMockResponse} from '@dynobox/sdk';
import type {IrScenario} from '@dynobox/sdk/ir';
import {execa} from 'execa';
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';

import {FakeHarness} from '../harnesses/fake.js';
import {runJob} from '../index.js';
import {type HttpCapture, startHttpCapture} from './proxy.js';

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => home,
}));

const requests: unknown[] = [];

const scenario: IrScenario = {
  id: 'scenario.http-mocks',
  name: 'http mocks',
  prompt: 'Call the API',
  harnesses: [{id: 'claude-code'}],
  setup: [],
  fixtures: [],
  cliMocks: {},
  endpoints: [],
  assertions: [],
  httpMocks: {
    'api.example.test': {
      handler: (request) => {
        requests.push(request);
        if (request.path === '/throws') throw new Error('boom');
        if (request.path === '/invalid')
          return {statusCode: 200} as unknown as {status: number};
        return {status: 201, json: {path: request.path, got: request.body}};
      },
    },
    'static.example.test': {
      response: {status: 418, headers: {'x-mock': 'yes'}, body: 'teapot'},
    },
  },
};

let home: string;
let capture: HttpCapture;

// curl sends CONNECT through the proxy, so the .test hosts never need DNS.
async function curlVia(env: Record<string, string>, ...args: string[]) {
  const result = await execa(
    'curl',
    ['-sS', '-i', '--max-time', '2', '--proxy', env.HTTPS_PROXY!, ...args],
    {env: {CURL_CA_BUNDLE: env.CURL_CA_BUNDLE!}, reject: false},
  );
  return result.stdout;
}

async function curl(...args: string[]) {
  return curlVia(capture.env, ...args);
}

describe('startHttpCapture with HTTP mocks', () => {
  beforeAll(async () => {
    // ensureDynoboxCA writes to ~/.dynobox; keep the test CA out of the real home.
    home = await mkdtemp(join(tmpdir(), 'dynobox-http-mocks-'));
    capture = (await startHttpCapture(scenario, '/work/dir'))!;
  });

  afterAll(async () => {
    await capture?.stop();
    await rm(home, {recursive: true, force: true});
  });

  it('sets the proxy env, with Node fetch opted in and a full CA bundle', () => {
    expect(capture.env).toMatchObject({
      HTTPS_PROXY: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
      NODE_USE_ENV_PROXY: '1',
      NODE_EXTRA_CA_CERTS: join(home, '.dynobox', 'ca.pem'),
      SSL_CERT_FILE: join(home, '.dynobox', 'ca-bundle.pem'),
      CURL_CA_BUNDLE: join(home, '.dynobox', 'ca-bundle.pem'),
    });
  });

  it('answers HTTPS requests from the handler, with the job workDir', async () => {
    const output = await curl(
      '-X',
      'POST',
      '--data',
      'hello',
      'https://api.example.test/v1/recall?limit=2',
    );

    expect(output).toContain('HTTP/1.1 201');
    expect(output).toContain('{"path":"/v1/recall","got":"hello"}');
    expect(requests.at(-1)).toMatchObject({
      method: 'POST',
      url: 'https://api.example.test/v1/recall?limit=2',
      path: '/v1/recall',
      body: 'hello',
      workDir: '/work/dir',
    });
    expect(capture.events.at(-1)).toMatchObject({
      method: 'POST',
      host: 'api.example.test',
      status: 201,
      mocked: true,
    });
  });

  it('answers plain HTTP requests from a static response', async () => {
    const output = await curl('http://static.example.test/anything');

    expect(output).toContain('HTTP/1.1 418');
    expect(output.toLowerCase()).toContain('x-mock: yes');
    expect(output).toContain('teapot');
  });

  it('records handler errors and invalid responses as failures', async () => {
    const output = await curl(
      'https://api.example.test/throws?token=TOP_SECRET',
    );
    expect(output).toContain('HTTP/1.1 500');
    expect(output).not.toContain('TOP_SECRET');
    expect(await curl('https://api.example.test/invalid')).toContain(
      'HTTP/1.1 500',
    );
    expect(capture.failures).toEqual([
      'HTTP mock for api.example.test failed on GET https://api.example.test/throws: boom',
      expect.stringMatching(
        /^HTTP mock for api\.example\.test failed on GET https:\/\/api\.example\.test\/invalid: invalid response:/,
      ),
    ]);
    expect(JSON.stringify(capture.failures)).not.toContain('TOP_SECRET');
  });

  const invalidResponses: [string, () => HttpMockResponse][] = [
    ['BigInt JSON', () => ({status: 200, json: {id: 1n}})],
    [
      'circular JSON',
      () => {
        const json: {self?: unknown} = {};
        json.self = json;
        return {status: 200, json};
      },
    ],
    ['function JSON', () => ({status: 200, json: () => 'not JSON'})],
    ['symbol JSON', () => ({status: 200, json: Symbol('not JSON')})],
    [
      'an invalid header name',
      () => ({status: 200, headers: {'bad header': 'value'}}),
    ],
    [
      'an invalid header value',
      () => ({status: 200, headers: {'x-bad': 'line\r\nbreak'}}),
    ],
  ];

  it.each(invalidResponses)(
    'fails the job when a mock returns %s',
    async (_label, response) => {
      const harness = new FakeHarness();
      const run = harness.run.bind(harness);
      vi.spyOn(harness, 'run').mockImplementation(async (input) => {
        const output = await curlVia(input.env, 'http://api.example.test/');
        expect(output).toContain('HTTP/1.1 500');
        return run(input);
      });
      const result = await runJob(
        {
          id: 'job.invalid-response',
          harness: 'claude-code',
          iteration: 0,
          scenario: {
            ...scenario,
            httpMocks: {'api.example.test': {handler: response}},
          },
        },
        {scratchRoot: home, harnesses: [harness]},
      );

      expect(result.status).toBe('harness_failed');
      expect(result.diagnostics).toEqual([
        expect.stringMatching(
          /^HTTP mock for api\.example\.test failed on GET http:\/\/api\.example\.test\/:/,
        ),
      ]);
      expect(result.httpEvents[0]?.status).toBe(500);
    },
  );

  it('serializes JSON once and keeps the JSON content type', async () => {
    const toJSON = vi.fn(() => ({ok: true}));
    const isolated = (await startHttpCapture(
      {
        ...scenario,
        httpMocks: {
          'api.example.test': {
            response: {
              status: 200,
              headers: {'Content-Type': 'text/plain'},
              json: {toJSON},
            },
          },
        },
      },
      '/work/dir',
    ))!;
    try {
      const output = await curlVia(isolated.env, 'http://api.example.test/');
      expect(output.toLowerCase()).toContain('content-type: application/json');
      expect(output).toContain('{"ok":true}');
      expect(toJSON).toHaveBeenCalledOnce();
      expect(isolated.failures).toEqual([]);
    } finally {
      await isolated.stop();
    }
  });

  it('fails the job without waiting for an unfinished handler', async () => {
    let started!: () => void;
    let rejectHandler!: (error: Error) => void;
    const starting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const response = new Promise<HttpMockResponse>((_resolve, reject) => {
      rejectHandler = reject;
    });
    let pendingRequest: Promise<string> | undefined;
    const harness = new FakeHarness();
    const run = harness.run.bind(harness);
    vi.spyOn(harness, 'run').mockImplementation(async (input) => {
      pendingRequest = curlVia(
        input.env,
        'http://api.example.test/pending?token=TOP_SECRET',
      );
      await starting;
      return run(input);
    });

    try {
      const result = await runJob(
        {
          id: 'job.pending-response',
          harness: 'claude-code',
          iteration: 0,
          scenario: {
            ...scenario,
            httpMocks: {
              'api.example.test': {
                handler: () => {
                  started();
                  return response;
                },
              },
            },
          },
        },
        {scratchRoot: home, harnesses: [harness]},
      );

      expect(result.status).toBe('harness_failed');
      expect(result.diagnostics).toEqual([
        'HTTP mock for api.example.test failed on GET http://api.example.test/pending: did not complete before the harness finished.',
      ]);
    } finally {
      rejectHandler(new Error('late handler failure'));
      await pendingRequest;
    }
  });

  it('finalizes pending failures once and ignores late handler errors', async () => {
    let started!: () => void;
    let rejectHandler!: (error: Error) => void;
    const starting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const response = new Promise<HttpMockResponse>((_resolve, reject) => {
      rejectHandler = reject;
    });
    const isolated = (await startHttpCapture(
      {
        ...scenario,
        httpMocks: {
          'api.example.test': {
            handler: () => {
              started();
              return response;
            },
          },
        },
      },
      '/work/dir',
    ))!;
    const pendingRequest = curlVia(isolated.env, 'http://api.example.test/');
    try {
      await starting;
      await isolated.stop();
      await isolated.stop();
      expect(isolated.failures).toEqual([
        'HTTP mock for api.example.test failed on GET http://api.example.test/: did not complete before the harness finished.',
      ]);
      rejectHandler(new Error('late handler failure'));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(isolated.failures).toHaveLength(1);
    } finally {
      rejectHandler(new Error('late handler failure'));
      await isolated.stop();
      await pendingRequest;
    }
  });
});
