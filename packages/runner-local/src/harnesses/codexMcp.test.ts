import {chmod, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {parse} from 'smol-toml';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {CodexHarness} from './codex.js';
import {type CodexMcpOptions, runCodexWithMcp} from './codexMcp.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await rm(root, {recursive: true, force: true});
});

async function fixture(
  mode = 'success',
  inherited: Record<string, unknown> = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'dynobox-codex-unit-'));
  roots.push(root);
  const executable = join(root, 'codex.mjs');
  const log = join(root, 'invocations.jsonl');
  await writeFile(
    executable,
    `#!${process.execPath}\nimport {parse} from ${JSON.stringify(import.meta.resolve('smol-toml'))};\n` +
      CHILD,
  );
  await chmod(executable, 0o700);
  const options: CodexMcpOptions = {
    executable,
    input: {
      prompt: 'Reply OK.',
      workDir: root,
      timeoutMs: 5000,
      env: {
        HOME: root,
        CODEX_HOME: root,
        DXB_MODE: mode,
        DXB_LOG: log,
        DXB_INHERITED: JSON.stringify(inherited),
      },
    },
    servers: {
      service: {url: 'http://127.0.0.1:12345/service', tools: ['lookup']},
    },
  };
  const invocations = async () =>
    (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  return {root, options, invocations};
}

const CHILD = String.raw`
import {appendFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
const args = process.argv.slice(2);
const mode = process.env.DXB_MODE;
appendFileSync(process.env.DXB_LOG,JSON.stringify({args,cwd:process.cwd(),noProxy:process.env.no_proxy,NO_PROXY:process.env.NO_PROXY,marker:process.env.DXB_MARKER})+'\n');
console.error('PRIVATE_STDERR_SENTINEL');
function hang() {
 if(process.env.DXB_PID) spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(process.env.DXB_PID,String(process.pid));setInterval(()=>{},1000)'],{stdio:'inherit'});
 setInterval(()=>{},1000);
}
if(args.includes('--version')) {
 console.log(mode==='version' ? 'codex-cli 0.100.0' : mode==='newer' ? 'codex-cli 0.999.0' : 'codex-cli 0.153.4');
 if(mode==='version-timeout') hang(); else process.exit(0);
} else {
 const overlay=parse(args.find(arg=>arg.startsWith('mcp_servers='))).mcp_servers;
 const servers=JSON.parse(process.env.DXB_INHERITED);
 for(const [name,entry] of Object.entries(overlay))servers[name]={...servers[name],...entry};
 const alias=Object.entries(overlay).find(([,entry])=>entry.required===true)[0];
 if(args.includes('get')) {
  if(mode==='probe-hang') hang();
  else if(mode==='get-exit'){console.log('PRIVATE_CONFIG_OUTPUT');process.exit(1);}
  else if(mode==='bad-metadata'){console.log('INVALID_CONFIG_JSON');process.exit(0);}
  else {
   const name=args.at(-1); const entry=servers[name];
   const value={name,enabled:entry.enabled!==false,disabled_reason:null,transport:{type:'streamable_http',url:entry.url,http_headers:entry.http_headers??null,env_http_headers:null,bearer_token_env_var:null,http_headers_helper:null},enabled_tools:null,disabled_tools:null};
   if(mode==='managed-enabled' && name==='service')value.enabled=true;
   if(mode==='managed-url' && name===alias)value.transport.url='http://original.example';
   if(mode==='managed-auth' && name===alias)value.transport.http_headers={Authorization:'PRIVATE_CREDENTIAL'};
   if(mode==='hidden' && name===alias)value.disabled_tools=['lookup'];
   if(mode==='wrong-name')value.name='different';
   console.log(JSON.stringify(value));process.exit(0);
  }
 } else if(mode==='hang')hang();
 else {
  const emit=value=>console.log(JSON.stringify(value));
  emit({type:'thread.started',thread_id:'fixture'});emit({type:'turn.started'});
  for(const event of JSON.parse(process.env.DXB_EVENTS||'[]')) {
   if(event.item?.server==='$mock')event.item.server=alias;
   emit(event);
  }
  if(mode==='tool')emit({type:'item.completed',item:{id:'call',type:'mcp_tool_call',server:alias,tool:'lookup',arguments:{key:'receipt'},status:'completed'}});
  if(mode==='reconnect')emit({type:'error',message:'Reconnecting...'});
  if(mode==='failed-turn')emit({type:'turn.failed',error:{message:(process.env.DXB_UPSTREAM_ERROR||'PRIVATE_UPSTREAM_ERROR').replace('$mock',alias)}});
  if(mode==='bad-json')console.log('PRIVATE_INVALID_JSON');
  emit({type:'item.completed',item:{type:'agent_message',text:'OK'}});
  if(mode!=='no-completion')emit({type:'turn.completed'});
  if(mode==='exit')process.exitCode=1;
 }
}
`;

const item = (server = '$mock', status = 'completed') => ({
  type: 'item.completed',
  item: {
    id: 'call-1',
    type: 'mcp_tool_call',
    server,
    tool: 'lookup',
    arguments: JSON.stringify({key: 'receipt'}),
    status,
  },
});

describe('Codex selective HTTP MCP adapter', () => {
  it('disables the original without copying its credentials and preserves unrelated configuration', async () => {
    const f = await fixture('tool', {
      service: {
        url: 'https://original.example',
        http_headers: {Authorization: 'PRIVATE_CREDENTIAL'},
      },
      github: {url: 'https://github.example'},
    });
    const run = await runCodexWithMcp(f.options);
    expect(run.toolEvents).toEqual([
      expect.objectContaining({
        rawName: 'mcp__service__lookup',
        status: 'success',
      }),
    ]);
    const calls = await f.invocations();
    expect(calls).toHaveLength(4);
    expect(JSON.stringify(calls)).not.toMatch(
      /PRIVATE_CREDENTIAL|plugins=|app-server|--disable/,
    );
    const config = parse(
      calls.at(-1).args.find((arg: string) => arg.startsWith('mcp_servers=')),
    ).mcp_servers as Record<string, Record<string, unknown>>;
    expect(config.service).toMatchObject({enabled: false});
    expect(config).not.toHaveProperty('github');
    const alias = Object.keys(
      run.output.metadata!.codexMcpAliases as object,
    )[0]!;
    expect(config[alias]).toMatchObject({
      url: f.options.servers.service!.url,
      required: true,
    });
    expect(config[alias]).not.toHaveProperty('http_headers');
    expect(new CodexHarness().extractResult(run.output).toolEvents).toEqual(
      run.toolEvents,
    );
  });

  it('keeps the logical server name in the native identity', async () => {
    const f = await fixture();
    const run = await runCodexWithMcp(f.options);
    expect(run.output.metadata?.codexMcpAliases).toEqual({
      service_dynobox: 'service',
    });
  });

  it.each([
    'managed-enabled',
    'managed-url',
    'managed-auth',
    'bad-metadata',
    'wrong-name',
    'get-exit',
  ])('rejects %s before task startup', async (mode) => {
    const f = await fixture(mode);
    await expect(runCodexWithMcp(f.options)).rejects.toMatchObject({
      category: 'configuration_failed',
    });
    expect(
      (await f.invocations()).some((call) => call.args[0] === 'exec'),
    ).toBe(false);
  });

  it('rejects unavailable mock tools before the task starts', async () => {
    const f = await fixture('hidden');
    await expect(runCodexWithMcp(f.options)).rejects.toMatchObject({
      category: 'not_ready',
    });
    expect(
      (await f.invocations()).some((call) => call.args[0] === 'exec'),
    ).toBe(false);
  });

  it('retains received service errors and unrelated MCP attempts, deduplicating native item IDs', async () => {
    const f = await fixture();
    const failure = {
      ...item(),
      item: {
        ...item().item,
        result: {
          isError: true,
          content: [{type: 'text', text: 'Permission denied: missing access'}],
        },
      },
    };
    f.options.input.env.DXB_EVENTS = JSON.stringify([
      failure,
      failure,
      {...item('github'), item: {...item('github').item, id: 'other'}},
    ]);
    const onToolEvent = vi.fn();
    f.options.input.onToolEvent = onToolEvent;
    const run = await runCodexWithMcp(f.options);
    expect(run.toolEvents).toEqual([
      expect.objectContaining({
        rawName: 'mcp__service__lookup',
        status: 'failure',
        message: 'Permission denied: missing access',
      }),
      expect.objectContaining({
        rawName: 'mcp__github__lookup',
        status: 'success',
      }),
    ]);
    expect(onToolEvent).toHaveBeenCalledTimes(2);
  });

  it('preserves failed attempts for shared receipt reconciliation', async () => {
    const f = await fixture();
    f.options.input.env.DXB_EVENTS = JSON.stringify([item('$mock', 'failed')]);
    expect((await runCodexWithMcp(f.options)).toolEvents).toContainEqual(
      expect.objectContaining({
        rawName: 'mcp__service__lookup',
        status: 'failure',
      }),
    );
  });

  it('keeps callback failure output when the deadline passes during error handling', async () => {
    const f = await fixture('tool');
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    f.options.input.onToolEvent = () => {
      now += 10000;
      throw new Error('Caller callback failed');
    };
    await expect(runCodexWithMcp(f.options)).rejects.toMatchObject({
      category: 'execution_failed',
      message: expect.stringContaining('Caller callback failed'),
      output: {stdout: expect.stringContaining('mcp_tool_call')},
    });
  });

  it('keeps model, permission, proxy and CLI-mock environment settings consistent', async () => {
    const f = await fixture();
    f.options.input.permissionMode = 'dangerous';
    f.options.input.model = 'fixture-model';
    f.options.input.cliMocksEnabled = true;
    Object.assign(f.options.input.env, {
      NO_PROXY: 'one.example',
      no_proxy: 'two.example',
      DYNOBOX_CLI_MOCK_BIN: '/fixture/bin',
      DXB_MARKER: 'preserved',
    });
    await runCodexWithMcp(f.options);
    const calls = await f.invocations();
    for (const call of calls) {
      expect(call.marker).toBe('preserved');
      expect(call.noProxy).toBe(call.NO_PROXY);
      expect(call.noProxy.split(',')).toEqual(
        expect.arrayContaining([
          'one.example',
          'two.example',
          '127.0.0.1',
          'localhost',
          '::1',
        ]),
      );
      expect(call.args).not.toContain('--ignore-user-config');
    }
    const exec = calls.at(-1).args;
    expect(
      exec.filter((arg: string) => arg === 'approval_policy="never"'),
    ).toHaveLength(1);
    expect(exec.filter((arg: string) => arg === '--model')).toHaveLength(1);
    expect(exec.filter((arg: string) => arg === '--sandbox')).toHaveLength(1);
    expect(exec).not.toContain('sandbox_mode="danger-full-access"');
    expect(exec).toContain(
      'shell_environment_policy.set.DYNOBOX_CLI_MOCK_BIN="/fixture/bin"',
    );
  });

  it('grants only the requested logical mock tool', async () => {
    const f = await fixture();
    f.options.input.allowedMcpTools = [{server: 'service', tool: 'lookup'}];
    await runCodexWithMcp(f.options);
    expect((await f.invocations()).at(-1).args.join(' ')).toContain(
      '"lookup"={"approval_mode"="approve"}',
    );
  });

  it.each([
    ['--profile', 'other'],
    ['-pother'],
    ['-C', '/elsewhere'],
    ['--cd=/elsewhere'],
    ['-C/elsewhere'],
    ['-c', 'mcp_servers={}'],
    ['--config=mcp_servers={}'],
    ['--ignore-user-config'],
    ['--enable', 'apps'],
    ['--disable', 'plugins'],
    ['--'],
    ['resume'],
  ])(
    'rejects launch-changing extra arguments %j before any process',
    async (...extraArgs) => {
      const f = await fixture();
      f.options.extraArgs = extraArgs;
      await expect(runCodexWithMcp(f.options)).rejects.toMatchObject({
        category: 'configuration_failed',
      });
      await expect(f.invocations()).rejects.toThrow();
    },
  );

  it.each([
    ['version', 'unsupported_version'],
    ['no-completion', 'execution_failed'],
    ['failed-turn', 'execution_failed'],
    ['bad-json', 'execution_failed'],
    ['exit', 'execution_failed'],
  ])('reports %s as %s with debug output', async (mode, category) => {
    const f = await fixture(mode);
    await expect(runCodexWithMcp(f.options)).rejects.toMatchObject({
      category,
      output: {
        stdout: expect.any(String),
        stderr: expect.stringContaining('PRIVATE_STDERR_SENTINEL'),
      },
    });
  });

  it('allows transient provider errors when the turn completes', async () => {
    const f = await fixture('reconnect');
    expect((await runCodexWithMcp(f.options)).harnessReady).toBe(true);
  });

  it('uses logical names in harness errors while retaining native debug output', async () => {
    const f = await fixture('failed-turn');
    f.options.input.env.DXB_UPSTREAM_ERROR = 'Mock $mock unavailable';
    await expect(runCodexWithMcp(f.options)).rejects.toMatchObject({
      message: 'Codex reported turn.failed: Mock service unavailable',
      output: {stdout: expect.stringContaining('service_dynobox')},
    });
  });

  it('accepts newer supported Codex releases', async () => {
    const f = await fixture('newer');
    expect((await runCodexWithMcp(f.options)).version).toBe('0.999.0');
  });

  it('requires actual endpoint discovery when an observer is supplied', async () => {
    const f = await fixture();
    f.options.servers = {
      service: {...f.options.servers.service!, isDiscovered: () => false},
    };
    await expect(runCodexWithMcp(f.options)).rejects.toMatchObject({
      category: 'not_ready',
    });
  });

  it.each(['version-timeout', 'probe-hang', 'hang'])(
    'classifies %s timeout even before the wall clock advances',
    async (mode) => {
      const f = await fixture(mode);
      f.options.input.timeoutMs = 500;
      vi.spyOn(Date, 'now').mockReturnValue(Date.now());
      await expect(runCodexWithMcp(f.options)).rejects.toMatchObject({
        category: 'timed_out',
        output: {stderr: expect.any(String)},
      });
    },
  );

  it('caps metadata inspection when no job deadline is configured', async () => {
    const f = await fixture('probe-hang');
    delete f.options.input.timeoutMs;
    await expect(runCodexWithMcp(f.options)).rejects.toMatchObject({
      category: 'timed_out',
    });
  }, 10000);

  it.each(['probe-hang', 'hang'])(
    'cancels %s and owned descendants',
    async (mode) => {
      const f = await fixture(mode);
      const pidPath = join(f.root, 'child.pid');
      f.options.input.env.DXB_PID = pidPath;
      const abort = new AbortController();
      f.options.input.signal = abort.signal;
      const pending = runCodexWithMcp(f.options).catch((error) => error);
      let pid: number | undefined;
      try {
        await vi.waitFor(
          async () => {
            pid = Number(await readFile(pidPath, 'utf8'));
          },
          {timeout: 3000},
        );
        abort.abort();
        expect(await pending).toMatchObject({category: 'execution_failed'});
        await vi.waitFor(() => expect(() => process.kill(pid!, 0)).toThrow(), {
          timeout: 2500,
        });
      } finally {
        abort.abort();
        if (pid) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* stopped */
          }
        }
        await pending;
      }
    },
    10000,
  );
});
