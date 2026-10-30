import {mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it, vi} from 'vitest';

import * as processGroup from '../processGroup.js';
import {
  prepareOpenCodeMcpConfiguration,
  runOpenCodeWithMcp,
} from './opencodeMcp.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await rm(root, {recursive: true, force: true});
});

async function fixture(mode = 'success') {
  const root = await mkdtemp(join(tmpdir(), 'dynobox-opencode-mcp-'));
  roots.push(root);
  const executable = join(root, 'opencode.mjs');
  const log = join(root, 'probes.jsonl');
  await writeFile(
    executable,
    `#!${process.execPath}
import {appendFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
const args = process.argv.slice(2);
const mode = process.env.DXB_TEST_MODE;
console.error('PRIVATE_STDERR_SENTINEL');
appendFileSync(process.env.DXB_TEST_LOG, JSON.stringify({args, cwd: process.cwd(), noProxy: process.env.no_proxy, NO_PROXY: process.env.NO_PROXY, marker: process.env.DXB_TEST_MARKER}) + '\\n');
if (mode === 'hang' || mode === 'serve-hang' && args.includes('serve') || mode === 'config-hang' && args.includes('debug')) {
  if (process.env.DXB_TEST_CHILD_PID) spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(process.env.DXB_TEST_CHILD_PID, String(process.pid)); setInterval(() => {}, 1000);'], {stdio: 'inherit'});
  setInterval(() => {}, 1000);
}
else if (args.includes('--version')) console.log(mode === 'version' ? '1.10.0' : mode === 'newer' ? '1.20.0' : '1.18.26');
else if (args.includes('serve') && mode === 'serve-exit') {console.log('PRIVATE_STDOUT_SENTINEL'); process.exit(2);}
else if (args.includes('serve')) {
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    let result = {};
    if (request.url === '/mcp') result = {linear: {status: 'connected'}};
    if (request.url === '/session') {
      appendFileSync(process.env.DXB_TEST_LOG + '.session', body);
      result = {id: 'test'};
    }
    if (request.url === '/permission' || request.method === 'GET' && request.url.endsWith('/message')) result = [];
    if (request.method === 'GET' && request.url.endsWith('/message') && mode === 'tool-error') result = [{info: {role: 'assistant'}, parts: [{id: 'tool-1', type: 'tool', tool: 'linear_get_issue', state: {status: 'error', input: {id: 'DYNO-1'}, error: 'Issue missing'}}]}];
    if (request.method === 'POST' && request.url.endsWith('/message')) {
      if (mode === 'request-hang') return;
      result = mode === 'model-error' ? {info: {error: {message: 'model failed'}}} : {info: {finish: 'stop'}};
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(mode === 'bad-response' && request.url === '/mcp' ? 'not JSON' : JSON.stringify(result));
  });
  server.listen(0, '127.0.0.1', () => console.log('http://127.0.0.1:' + server.address().port));
}
else {
  const config = {mcp: {real: {type: 'local', command: ['real-server'], environment: {SECRET: 'PRIVATE_SENTINEL'}}, unrelated: {type: 'remote', url: 'https://private.invalid/PRIVATE_SENTINEL', headers: {Authorization: 'PRIVATE_SENTINEL'}}}};
  const inline = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}');
  config.permission = inline.permission || {};
  config.agent = inline.agent || {};
  config.default_agent = inline.default_agent;
  for (const [name, entry] of Object.entries(inline.mcp || {})) config.mcp[name] = {...config.mcp[name], ...entry};
  if (mode === 'exit') process.exit(2);
  console.log(JSON.stringify(config));
}
`,
    {mode: 0o700},
  );
  const options = {
    executable,
    input: {
      workDir: root,
      timeoutMs: 5000,
      env: {
        HOME: root,
        XDG_CONFIG_HOME: join(root, 'config'),
        DXB_TEST_MODE: mode,
        DXB_TEST_LOG: log,
        DXB_TEST_MARKER: 'preserved',
        NO_PROXY: 'one.example',
        no_proxy: 'two.example',
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          model: 'example/model',
          permission: {edit: 'deny'},
          mcp: {inline: {type: 'local', command: ['inline-server']}},
        }),
      },
    },
    servers: {
      linear: {
        url: 'http://127.0.0.1:12345/linear',
        tools: ['get_issue'],
      },
    },
  };
  return {options, log};
}

describe('OpenCode MCP configuration preparation', () => {
  it('retains tool error messages when mapping MCP names', async () => {
    const {options} = await fixture('tool-error');
    const run = await runOpenCodeWithMcp({
      ...options,
      input: {...options.input, prompt: 'OK'},
    });
    expect(run.toolEvents).toEqual([
      expect.objectContaining({
        rawName: 'mcp__linear__get_issue',
        status: 'failure',
        message: 'Issue missing',
      }),
    ]);
  });

  it('keeps a callback failure when its deadline passes', async () => {
    const {options} = await fixture('tool-error');
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await expect(
      runOpenCodeWithMcp({
        ...options,
        input: {
          ...options.input,
          prompt: 'OK',
          onToolEvent: () => {
            now += 10_000;
            throw new Error('Caller callback failed');
          },
        },
      }),
    ).rejects.toMatchObject({
      category: 'execution_failed',
      message: expect.stringContaining('Caller callback failed'),
      output: {stderr: expect.stringContaining('PRIVATE_STDERR_SENTINEL')},
    });
  });

  it.each(['model-error', 'bad-response'])(
    'keeps a %s failure when cleanup passes the deadline',
    async (mode) => {
      const {options} = await fixture(mode);
      let now = Date.now();
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      const start = processGroup.startOwnedProcess;
      vi.spyOn(processGroup, 'startOwnedProcess').mockImplementation(
        (executable, args, options) => {
          const child = start(executable, args, options);
          if (args.includes('serve')) {
            const stop = child.stop;
            child.stop = () => {
              now += 10_000;
              stop();
            };
          }
          return child;
        },
      );
      await expect(
        runOpenCodeWithMcp({
          ...options,
          input: {...options.input, prompt: 'OK'},
        }),
      ).rejects.toMatchObject({
        category: 'execution_failed',
        message: expect.stringContaining(
          mode === 'model-error' ? 'model failed' : 'JSON',
        ),
      });
    },
  );

  it.each(['--attach', '--dir', '--agent', '--continue', '--session'])(
    'rejects extra arguments before any probe: %s',
    async (arg) => {
      const {options, log} = await fixture();
      await expect(
        runOpenCodeWithMcp({
          ...options,
          input: {...options.input, prompt: 'OK'},
          extraArgs: [arg, 'unexpected'],
        }),
      ).rejects.toMatchObject({category: 'configuration_failed'});
      await expect(readFile(log)).rejects.toMatchObject({code: 'ENOENT'});
    },
  );

  it('maps explicit grants without changing unrelated denials', async () => {
    const {options} = await fixture();
    const prepared = await prepareOpenCodeMcpConfiguration({
      ...options,
      input: {
        ...options.input,
        allowedMcpTools: [{server: 'linear', tool: 'get_issue'}],
      },
    });
    expect(
      JSON.parse(prepared.env.OPENCODE_CONFIG_CONTENT!).permission,
    ).toEqual({edit: 'deny', linear_get_issue: 'allow', question: 'deny'});
    expect(prepared.denials).toContainEqual({
      permission: 'edit',
      pattern: '*',
      action: 'deny',
    });
  });
  it('honors the last matching permission rule and ignores other agents', async () => {
    const {options} = await fixture();
    options.input.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      permission: {
        '*': 'deny',
        linear_get_issue: 'allow',
        bash: 'ask',
        edit: {'*.md': 'ask'},
      },
      agent: {review: {permission: {linear_get_issue: 'deny'}}},
    });
    const prepared = await prepareOpenCodeMcpConfiguration(options);
    expect(
      JSON.parse(prepared.env.OPENCODE_CONFIG_CONTENT!).permission,
    ).toMatchObject({
      '*': 'deny',
      linear_get_issue: 'allow',
    });
    // Dangerous-mode session rules approve `ask`, like `opencode run --auto`.
    expect(prepared.denials).toEqual([
      {permission: '*', pattern: '*', action: 'deny'},
      {permission: 'linear_get_issue', pattern: '*', action: 'allow'},
      {permission: 'bash', pattern: '*', action: 'allow'},
      {permission: 'edit', pattern: '*.md', action: 'allow'},
    ]);
  });

  it('lets an explicit grant override a matching deny', async () => {
    const {options} = await fixture();
    options.input.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      permission: {'*': 'deny'},
    });
    const prepared = await prepareOpenCodeMcpConfiguration({
      ...options,
      input: {
        ...options.input,
        allowedMcpTools: [{server: 'linear', tool: 'get_issue'}],
      },
    });
    expect(
      JSON.parse(prepared.env.OPENCODE_CONFIG_CONTENT!).permission,
    ).toMatchObject({
      '*': 'deny',
      linear_get_issue: 'allow',
    });
  });

  it('appends an existing tool grant after matching wildcard rules', async () => {
    const {options} = await fixture();
    options.input.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      permission: {linear_get_issue: 'ask', '*': 'deny'},
    });
    const prepared = await prepareOpenCodeMcpConfiguration({
      ...options,
      input: {
        ...options.input,
        allowedMcpTools: [{server: 'linear', tool: 'get_issue'}],
      },
    });
    const rules = Object.entries(
      JSON.parse(prepared.env.OPENCODE_CONFIG_CONTENT!).permission,
    );
    expect(
      rules.findIndex(([name]) => name === 'linear_get_issue'),
    ).toBeGreaterThan(rules.findIndex(([name]) => name === '*'));
    expect(rules).toContainEqual(['linear_get_issue', 'allow']);
  });

  it.each(['default', 'dangerous'] as const)(
    'denies questions after agent and wildcard rules in %s mode',
    async (permissionMode) => {
      const {options, log} = await fixture();
      options.input.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        permission: {question: 'allow', '*': 'allow'},
        agent: {build: {permission: {question: 'allow'}}},
      });
      await runOpenCodeWithMcp({
        ...options,
        input: {...options.input, prompt: 'OK', permissionMode},
      });
      const session = JSON.parse(await readFile(log + '.session', 'utf8'));
      expect(session.permission.at(-1)).toEqual({
        permission: 'question',
        pattern: '*',
        action: 'deny',
      });
      if (permissionMode === 'default')
        expect(session.permission).toHaveLength(1);
    },
  );

  it('rejects a selected agent denial that takes precedence over a grant', async () => {
    const {options} = await fixture();
    options.input.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      agent: {build: {permission: {linear_get_issue: 'deny'}}},
    });
    await expect(
      prepareOpenCodeMcpConfiguration({
        ...options,
        input: {
          ...options.input,
          allowedMcpTools: [{server: 'linear', tool: 'get_issue'}],
        },
      }),
    ).rejects.toMatchObject({category: 'not_ready'});
  });
  it('disables inherited sources and preserves unrelated inline settings', async () => {
    const {options, log} = await fixture();
    const original = structuredClone(options);
    const prepared = await prepareOpenCodeMcpConfiguration(options);
    expect(options).toEqual(original);
    expect(prepared.version).toBe('1.18.26');
    const overlay = JSON.parse(prepared.env.OPENCODE_CONFIG_CONTENT!);
    expect(overlay.model).toBe('example/model');
    expect(overlay.permission).toEqual({edit: 'deny', question: 'deny'});
    expect(overlay.mcp.real).toEqual({enabled: false});
    expect(overlay.mcp.unrelated).toEqual({enabled: false});
    expect(overlay.mcp.inline).toEqual({
      type: 'local',
      command: ['inline-server'],
      enabled: false,
    });
    expect(overlay.mcp.linear).toEqual({
      type: 'remote',
      url: options.servers.linear.url,
      enabled: true,
      oauth: false,
      timeout: 10_000,
    });
    const probes = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(probes.map((probe) => probe.args)).toEqual([
      ['--pure', '--version'],
      ['--pure', 'debug', 'config'],
    ]);
    for (const probe of probes) {
      expect(probe.cwd).toBe(await realpath(prepared.cwd));
      expect(probe.marker).toBe('preserved');
      expect(probe.noProxy).toBe(probe.NO_PROXY);
      expect(probe.NO_PROXY.split(',')).toEqual([
        'one.example',
        'two.example',
        '127.0.0.1',
        'localhost',
        '::1',
      ]);
    }
  });

  it.each(['real', 'inline'])(
    'fails when the config already has a server named %s',
    async (name) => {
      const {options} = await fixture();
      options.servers = {
        [name]: {url: 'http://127.0.0.1:12345/x', tools: ['search']},
      } as never;
      await expect(
        prepareOpenCodeMcpConfiguration(options),
      ).rejects.toMatchObject({
        category: 'configuration_failed',
        message: expect.stringContaining(`MCP server named "${name}"`),
      });
    },
  );

  it('fails when two mocks map to the same OpenCode tool id', async () => {
    const {options} = await fixture();
    options.servers = {
      a: {url: 'http://127.0.0.1:12345/a', tools: ['b_c']},
      a_b: {url: 'http://127.0.0.1:12345/a_b', tools: ['c']},
    } as never;
    await expect(
      prepareOpenCodeMcpConfiguration(options),
    ).rejects.toMatchObject({
      category: 'configuration_failed',
      message: expect.stringContaining('"a_b_c"'),
    });
  });

  it('reports a failed config read with the command', async () => {
    const {options} = await fixture('exit');
    await expect(
      prepareOpenCodeMcpConfiguration(options),
    ).rejects.toMatchObject({
      category: 'configuration_failed',
      message: 'opencode debug config exited with code 2.',
    });
  });

  it.each([
    ['version', false],
    ['newer', true],
  ])('checks the minimum CLI version (%s)', async (mode, supported) => {
    const {options} = await fixture(mode);
    const pending = prepareOpenCodeMcpConfiguration(options);
    if (supported) expect((await pending).version).toBe('1.20.0');
    else
      await expect(pending).rejects.toMatchObject({
        category: 'unsupported_version',
        message: expect.stringContaining('1.18.26 or newer'),
      });
  });

  it.each(['version', 'exit'])(
    'retains raw output from a %s preflight failure',
    async (mode) => {
      const {options} = await fixture(mode);
      await expect(
        prepareOpenCodeMcpConfiguration(options),
      ).rejects.toMatchObject({
        output: {
          stderr: expect.stringContaining('PRIVATE_STDERR_SENTINEL'),
          stdout: expect.any(String),
        },
      });
    },
  );

  it.each(['serve-exit', 'model-error'])(
    'retains server output from a %s run failure',
    async (mode) => {
      const {options} = await fixture(mode);
      await expect(
        runOpenCodeWithMcp({
          ...options,
          input: {...options.input, prompt: 'OK'},
        }),
      ).rejects.toMatchObject({
        category: 'execution_failed',
        output: {
          stderr: expect.stringContaining('PRIVATE_STDERR_SENTINEL'),
          stdout: expect.stringContaining(
            mode === 'serve-exit'
              ? 'PRIVATE_STDOUT_SENTINEL'
              : 'http://127.0.0.1:',
          ),
        },
      });
    },
  );

  it.each(['hang', 'config-hang', 'serve-hang', 'request-hang'])(
    'reports %s as a timeout with raw output before the clock deadline passes',
    async (mode) => {
      const {options} = await fixture(mode);
      options.input.timeoutMs = 500;
      vi.spyOn(Date, 'now').mockReturnValue(Date.now());
      await expect(
        runOpenCodeWithMcp({
          ...options,
          input: {...options.input, prompt: 'OK'},
        }),
      ).rejects.toMatchObject({
        category: 'timed_out',
        output: {
          stderr: expect.stringContaining('PRIVATE_STDERR_SENTINEL'),
          stdout: expect.any(String),
        },
      });
    },
  );

  it('bounds hanging probes by the invocation deadline', async () => {
    const {options} = await fixture('hang');
    options.input.timeoutMs = 100;
    await expect(
      prepareOpenCodeMcpConfiguration(options),
    ).rejects.toMatchObject({
      category: 'timed_out',
    });
  });

  it.each(['hang', 'serve-hang'])(
    'stops descendants holding stdout open when %s times out',
    async (mode) => {
      const {options, log} = await fixture(mode);
      const pidPath = log + '.child';
      Object.assign(options.input.env, {DXB_TEST_CHILD_PID: pidPath});
      options.input.timeoutMs = 1000;
      const pending = runOpenCodeWithMcp({
        ...options,
        input: {...options.input, prompt: 'OK'},
      }).catch((error: unknown) => error);
      let childPid: number | undefined;
      try {
        await vi.waitFor(async () => {
          childPid = Number(await readFile(pidPath, 'utf8'));
        });
        expect(await pending).toMatchObject({category: 'timed_out'});
        await vi.waitFor(() =>
          expect(() => process.kill(childPid!, 0)).toThrow(),
        );
      } finally {
        if (childPid !== undefined) {
          try {
            process.kill(childPid, 'SIGKILL');
          } catch {
            /* Already stopped. */
          }
        }
        await pending;
      }
    },
  );

  it('rejects cancellation before launching probes', async () => {
    const {options, log} = await fixture();
    await expect(
      prepareOpenCodeMcpConfiguration({
        ...options,
        input: {...options.input, signal: AbortSignal.abort()},
      }),
    ).rejects.toMatchObject({category: 'execution_failed'});
    await expect(readFile(log)).rejects.toMatchObject({code: 'ENOENT'});
  });
});

const nativeExecutable = process.env.DYNOBOX_OPENCODE_MCP_EXECUTABLE;
describe.skipIf(nativeExecutable === undefined)(
  'native OpenCode MCP configuration gate (no model requests)',
  () => {
    it.each([true, false])(
      'resolves the overlay against real config sources (authored schema: %s)',
      async (withSchema) => {
        const {options} = await fixture();
        const configPath = join(options.input.workDir, 'opencode.json');
        const source = JSON.stringify({
          ...(withSchema ? {$schema: 'https://opencode.ai/config.json'} : {}),
          mcp: {
            real: {type: 'local', command: [process.execPath, '--version']},
            unrelated: {type: 'remote', url: 'http://127.0.0.1:1/mcp'},
          },
        });
        await writeFile(configPath, source);
        const pending = prepareOpenCodeMcpConfiguration({
          ...options,
          executable: nativeExecutable!,
          input: {
            ...options.input,
            timeoutMs: 10_000,
            env: {
              HOME: options.input.workDir,
              XDG_CONFIG_HOME: join(options.input.workDir, 'config'),
              XDG_DATA_HOME: join(options.input.workDir, 'data'),
              XDG_CACHE_HOME: join(options.input.workDir, 'cache'),
              XDG_STATE_HOME: join(options.input.workDir, 'state'),
              OPENCODE_CONFIG: configPath,
              OPENCODE_CONFIG_DIR: options.input.workDir,
              OPENCODE_CONFIG_CONTENT: '{}',
              OPENCODE_DISABLE_MODELS_FETCH: 'true',
            },
          },
        });
        const prepared = await pending;
        const overlay = JSON.parse(prepared.env.OPENCODE_CONFIG_CONTENT!);
        expect(overlay.mcp.real).toEqual({enabled: false});
        expect(overlay.mcp.linear).toMatchObject({enabled: true});
        expect(overlay.mcp.unrelated).toEqual({enabled: false});
      },
    );
  },
);
