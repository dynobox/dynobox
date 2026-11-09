import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it, vi} from 'vitest';

import {OpenCodeHarness} from './opencode.js';
import {
  prepareOpenCodeMcpConfiguration,
  runOpenCodeWithMcp,
} from './opencodeMcp.js';
import type {HarnessInput} from './types.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await rm(root, {recursive: true, force: true});
});

async function fixture(mode = 'success') {
  const root = await mkdtemp(join(tmpdir(), 'dynobox-opencode-cli-'));
  roots.push(root);
  const executable = join(root, 'opencode.mjs');
  const log = join(root, 'requests.jsonl');
  await writeFile(executable, `#!${process.execPath}\n` + CHILD, {mode: 0o700});
  const input: HarnessInput = {
    workDir: root,
    prompt: 'Use the mock.',
    timeoutMs: 5000,
    env: {
      ...Object.fromEntries(
        Object.keys(process.env)
          .filter(
            (key) => key.startsWith('OPENCODE_') || key.startsWith('XDG_'),
          )
          .map((key) => [key, undefined]),
      ),
      HOME: root,
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'),
      XDG_CACHE_HOME: join(root, 'cache'),
      XDG_STATE_HOME: join(root, 'state'),
      OPENCODE_CONFIG_DIR: join(root, 'config', 'opencode'),
      OPENCODE_CONFIG_CONTENT: '{}',
      DXB_MODE: mode,
      DXB_LOG: log,
      NO_PROXY: 'one.example',
      no_proxy: 'two.example',
    },
  };
  const records = async () =>
    (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  return {
    root,
    log,
    records,
    options: {
      executable,
      input,
      servers: {linear: {url: 'http://127.0.0.1:1/mcp', tools: ['get_issue']}},
    },
  };
}

const tool = (name = 'linear_get_issue', id = 1, timestamp = 10) => ({
  type: 'tool_use',
  sessionID: 'root',
  timestamp,
  part: {
    type: 'tool',
    partID: `part-${id}`,
    id: 'provider-call',
    messageID: `message-${id}`,
    tool: name,
    state: {status: 'completed', input: {id}},
  },
});
const answer = (text = 'OK') => [
  {
    type: 'text',
    sessionID: 'root',
    timestamp: 30,
    part: {type: 'text', id: 'text', messageID: 'last', text},
  },
  {
    type: 'step_finish',
    sessionID: 'root',
    timestamp: 40,
    part: {type: 'step-finish', messageID: 'last', reason: 'stop'},
  },
];
const childMessage = (id = 2, timestamp = 5) => ({
  type: 'assistant',
  id: `child-message-${id}`,
  finish: 'stop',
  content: [
    {
      type: 'tool',
      id: `call-${id}`,
      name: 'linear_get_issue',
      time: {ran: timestamp},
      state: {status: 'completed', input: {id}},
    },
  ],
});

// Process-boundary fixture only. Native gates separately verify the real CLI.
const CHILD = String.raw`
import {appendFileSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
const args = process.argv.slice(2);
const mode = process.env.DXB_MODE;
const sid = process.env.DXB_SESSION_ID || 'root';
const record = value => appendFileSync(process.env.DXB_LOG, JSON.stringify(value) + String.fromCharCode(10));
record({args, NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy});
console.error('PRIVATE_STDERR');
if (args.includes('--version')) {
  if (mode === 'probe-hang') await new Promise(() => setInterval(() => {},1000));
  console.log(process.env.DXB_VERSION || '2.2.5');
  process.exit(0);
}
if (args[0] === 'run') {
  const chunks=[]; for await(const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  record({prompt: Buffer.concat(chunks).toString('utf8'), cli: true});
  if(mode==='run-child') {
    spawn(process.execPath,['-e','process.on("SIGTERM",()=>{}); require("node:fs").writeFileSync(process.env.DXB_PID,String(process.pid)); setInterval(()=>{},1000)'],{stdio:'inherit'});
    await new Promise(() => setInterval(()=>{},1000));
  }
  if(mode==='cli-hang') await new Promise(() => setInterval(()=>{},1000));
  if(mode==='malformed') {console.log('PRIVATE_INVALID_JSON');process.exit(0);}
  if(mode==='cli-error') {console.log(JSON.stringify({type:'error',error:{message:'PRIVATE_UPSTREAM_ERROR'}}));process.exit(1);}
  const events=process.env.DXB_EVENTS ? JSON.parse(process.env.DXB_EVENTS) : [
    {type:'text',sessionID:sid,timestamp:30,part:{type:'text',id:'text',messageID:'last',text:'OK'}},
    {type:'step_finish',sessionID:sid,timestamp:40,part:{type:'step-finish',messageID:'last',reason:'stop'}}
  ];
  for(const event of events) console.log(JSON.stringify(event));
  process.exit(0);
}
if(mode==='serve-exit') {console.log('PRIVATE_SERVER_OUTPUT');process.exit(2);}
if(mode==='serve-hang') await new Promise(() => setInterval(()=>{},1000));
let agentReads=0;
let mcpReads=0;
const server=createServer(async(req,res)=>{
  let text='';for await(const chunk of req) text+=chunk;
  record({path:req.url,body:text ? JSON.parse(text) : undefined, authenticated:req.headers.authorization==='Basic '+Buffer.from('opencode:'+process.env.OPENCODE_PASSWORD).toString('base64')});
  const path=req.url;
  const url=new URL(path,'http://localhost');
  let result={};
  if(path==='/api/config') result=mode==='bad-config' ? {} : [{type:'document',info:JSON.parse(process.env.OPENCODE_CONFIG_CONTENT)}];
  if(path==='/api/agent') result={data:mode==='agent-pending' && agentReads++===0 ? [] : [{id:'build',permissions:JSON.parse(process.env.DXB_RULES || '[]')}]};
  if(path==='/api/mcp') {
    if(mode==='request-hang') return;
    if(mode==='http-error') {res.writeHead(503).end();return;}
    if(mode==='bad-json') {res.end('not JSON');return;}
    result={data:mode==='bad-status' ? {} : [{name:'linear',status:{status:mode==='disconnected' ? 'failed' : mode==='mcp-pending' && mcpReads++===0 ? 'pending' : 'connected'}}, {name:mode==='collision' ? 'linear_get' : 'github',status:{status:'connected'}}]};
  }
  if(path==='/api/session') result={data:{id:sid}};
  if(url.pathname==='/api/session' && url.searchParams.has('parentID')) {
    const parent=url.searchParams.get('parentID');
    const paged=mode==='child-paged' && parent===sid && !url.searchParams.has('cursor');
    const children=mode.startsWith('child-') && parent===sid && !paged ? [{id:'child'}] : mode==='child-nested' && parent==='child' ? [{id:'nested'},{id:sid}] : [];
    result={data:mode==='child-bad-list' ? {} : children,cursor:{next:paged ? 'next' : null}};
  }
  if(path.endsWith('/export')) result={data:{messages:JSON.parse(process.env.DXB_CHILD_HISTORY || '[]')}};
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
});
server.listen(0,'127.0.0.1',()=>{
  const port=String(server.address().port);
  if(mode==='split-port') {process.stdout.write('http://127.0.0.1:'+port.slice(0,2));setTimeout(()=>console.log(port.slice(2)),30);}
  else console.log('http://127.0.0.1:'+port);
});
`;

describe('OpenCode selective configuration', () => {
  it('replaces a whole target while preserving unrelated inline settings and policies', async () => {
    const {options, root} = await fixture();
    const inherited = {
      mcp: {
        servers: {
          linear: {
            type: 'remote',
            url: 'https://original.example',
            headers: {Authorization: 'PRIVATE_TOKEN'},
          },
          github: {type: 'remote', url: 'https://github.example'},
        },
      },
      providers: {custom: {name: 'Custom'}},
      policies: [{action: 'integration.*', resource: '*', effect: 'allow'}],
      permissions: [{action: 'shell', resource: '*', effect: 'ask'}],
    };
    options.input.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(inherited);
    const path = join(root, 'opencode.json');
    await writeFile(path, JSON.stringify(inherited));
    options.input.allowedMcpTools = [{server: 'linear', tool: 'get_issue'}];
    const config = await prepareOpenCodeMcpConfiguration(options);
    const inline = JSON.parse(config.env.OPENCODE_CONFIG_CONTENT!);
    expect(inline.mcp.servers.linear).toMatchObject({
      url: options.servers.linear.url,
      oauth: false,
      codemode: false,
    });
    expect(inline.mcp.servers.linear).not.toHaveProperty('headers');
    expect(inline.mcp.servers.github).toEqual(inherited.mcp.servers.github);
    expect(inline.policies).toEqual(inherited.policies);
    expect(inline.providers).toEqual(inherited.providers);
    expect(inline.permissions).toEqual([
      ...inherited.permissions,
      {action: 'linear_get_issue', resource: '*', effect: 'allow'},
    ]);
    expect(await readFile(path, 'utf8')).toBe(JSON.stringify(inherited));
  });

  it.each(['1.18.26', '2.2.4', '3.0.0'])(
    'rejects unsupported CLI %s',
    async (version) => {
      const {options} = await fixture();
      options.input.env.DXB_VERSION = version;
      await expect(
        prepareOpenCodeMcpConfiguration(options),
      ).rejects.toMatchObject({category: 'unsupported_version'});
    },
  );

  it.each(['model', '/model', 'provider/', 'p/id#', 'p/id#a#b'])(
    'rejects malformed model %s before a probe',
    async (model) => {
      const {options, log} = await fixture();
      options.input.model = model;
      await expect(
        prepareOpenCodeMcpConfiguration(options),
      ).rejects.toMatchObject({category: 'configuration_failed'});
      await expect(readFile(log)).rejects.toThrow();
    },
  );

  it.each(['{broken', '[]', 'null'])(
    'rejects invalid inline JSONC: %s',
    async (value) => {
      const {options, log} = await fixture();
      options.input.env.OPENCODE_CONFIG_CONTENT = value;
      await expect(
        prepareOpenCodeMcpConfiguration(options),
      ).rejects.toMatchObject({category: 'configuration_failed'});
      await expect(readFile(log)).rejects.toThrow();
    },
  );

  it('accepts comments and trailing commas', async () => {
    const {options} = await fixture();
    options.input.env.OPENCODE_CONFIG_CONTENT =
      '{/* test */"model":"fixture/model",}';
    expect(
      JSON.parse(
        (await prepareOpenCodeMcpConfiguration(options)).env
          .OPENCODE_CONFIG_CONTENT!,
      ).model,
    ).toBe('fixture/model');
  });

  it('rejects ambiguous mock tool IDs', async () => {
    const {options} = await fixture();
    await expect(
      prepareOpenCodeMcpConfiguration({
        ...options,
        servers: {
          a: {url: 'http://127.0.0.1:1', tools: ['b_c']},
          a_b: {url: 'http://127.0.0.1:1', tools: ['c']},
        },
      }),
    ).rejects.toMatchObject({category: 'configuration_failed'});
  });

  it('does not accept arguments that change the prepared launch', async () => {
    const {options, log} = await fixture();
    await expect(
      runOpenCodeWithMcp({...options, extraArgs: ['--server', 'elsewhere']}),
    ).rejects.toMatchObject({category: 'configuration_failed'});
    await expect(readFile(log)).rejects.toThrow();
  });

  it('bounds the version probe without a job deadline', async () => {
    const {options} = await fixture('probe-hang');
    delete options.input.timeoutMs;
    await expect(
      prepareOpenCodeMcpConfiguration(options),
    ).rejects.toMatchObject({category: 'timed_out'});
  }, 10000);
});

describe('OpenCode public CLI execution', () => {
  it.each(['success', 'split-port', 'agent-pending', 'mcp-pending'])(
    'runs after %s readiness and closes its private server',
    async (mode) => {
      const {options, records} = await fixture(mode);
      const result = await runOpenCodeWithMcp(options);
      expect(result.harnessReady).toBe(true);
      expect(
        new OpenCodeHarness().extractResult(result.output).finalMessage,
      ).toBe('OK');
      const log = await records();
      const run = log.find((entry) => entry.args?.[0] === 'run');
      expect(run.args).toEqual(
        expect.arrayContaining([
          '--server',
          '--session',
          'root',
          '--format',
          'json',
        ]),
      );
      const base = run.args[run.args.indexOf('--server') + 1];
      await expect(fetch(base + '/api/mcp')).rejects.toThrow();
      expect(
        log.filter((entry) => entry.path).every((entry) => entry.authenticated),
      ).toBe(true);
    },
  );

  it('sends a literal multiline Unicode prompt through stdin and preserves model/permission choices', async () => {
    const {options, records} = await fixture();
    options.input.prompt =
      '- Keep "quotes", $(literal), and Unicode: é 🧪\n\nExact spacing.';
    options.input.model = 'provider/model#fast';
    options.input.permissionMode = 'dangerous';
    options.input.allowedMcpTools = [{server: 'linear', tool: 'get_issue'}];
    options.input.env.OPENCODE_PASSWORD = 'existing-password';
    options.input.env.OPENCODE_SERVER_PASSWORD = 'existing-other-password';
    await runOpenCodeWithMcp(options);
    const log = await records();
    expect(log.find((entry) => entry.cli).prompt).toBe(options.input.prompt);
    expect(log.find((entry) => entry.args?.[0] === 'run').args).toEqual(
      expect.arrayContaining(['--model', 'provider/model#fast', '--auto']),
    );
    expect(
      log.find((entry) => entry.path === '/api/session').body,
    ).toMatchObject({
      model: {providerID: 'provider', id: 'model', variant: 'fast'},
      permissions: [
        {action: 'linear_get_issue', resource: '*', effect: 'allow'},
        {action: 'question', resource: '*', effect: 'deny'},
      ],
    });
  });

  it('retains attempts under logical names and deduplicates repeated native part IDs', async () => {
    const {options} = await fixture();
    const first = tool();
    options.input.env.DXB_EVENTS = JSON.stringify([
      first,
      first,
      tool('linear_get_issue', 2, 20),
      ...answer(),
    ]);
    const result = await runOpenCodeWithMcp(options);
    expect(result.toolEvents?.map((event) => event.input)).toEqual([
      {id: 1},
      {id: 2},
    ]);
    expect(
      result.toolEvents?.every(
        (event) => event.rawName === 'mcp__linear__get_issue',
      ),
    ).toBe(true);
  });

  it('does not substitute an earlier answer for a textless final turn', async () => {
    const {options} = await fixture();
    options.input.env.DXB_EVENTS = JSON.stringify([
      ...answer('Earlier'),
      {
        type: 'step_finish',
        sessionID: 'root',
        timestamp: 50,
        part: {messageID: 'final', reason: 'stop'},
      },
    ]);
    const result = await runOpenCodeWithMcp(options);
    expect(
      new OpenCodeHarness().extractResult(result.output).finalMessage,
    ).toBeUndefined();
  });

  it.each(['disconnected', 'bad-status', 'collision'])(
    'rejects %s before launching the task',
    async (mode) => {
      const {options, records} = await fixture(mode);
      await expect(runOpenCodeWithMcp(options)).rejects.toMatchObject({
        category: mode === 'collision' ? 'configuration_failed' : 'not_ready',
      });
      expect((await records()).some((entry) => entry.args?.[0] === 'run')).toBe(
        false,
      );
    },
  );

  it('does not trust native status without observed fixture discovery', async () => {
    const {options, records} = await fixture();
    options.input.timeoutMs = 700;
    await expect(
      runOpenCodeWithMcp({
        ...options,
        servers: {
          linear: {...options.servers.linear, isDiscovered: () => false},
        },
      }),
    ).rejects.toMatchObject({category: 'timed_out'});
    expect((await records()).some((entry) => entry.args?.[0] === 'run')).toBe(
      false,
    );
  });

  it('preserves explicit deny rules before model execution', async () => {
    const {options, records} = await fixture();
    options.input.env.DXB_RULES = JSON.stringify([
      {action: 'linear_*', resource: '*', effect: 'deny'},
    ]);
    await expect(runOpenCodeWithMcp(options)).rejects.toMatchObject({
      category: 'not_ready',
    });
    expect((await records()).some((entry) => entry.args?.[0] === 'run')).toBe(
      false,
    );
  });

  it.each(['bad-config', 'bad-json', 'http-error', 'malformed', 'cli-error'])(
    'fails safely on %s',
    async (mode) => {
      const {options} = await fixture(mode);
      await expect(runOpenCodeWithMcp(options)).rejects.toMatchObject({
        category: expect.stringMatching(
          /configuration_failed|execution_failed/,
        ),
        output: {stderr: expect.stringContaining('PRIVATE_STDERR')},
      });
    },
  );

  it('cannot treat a length finish as completed', async () => {
    const {options} = await fixture();
    options.input.env.DXB_EVENTS = JSON.stringify([
      {type: 'step_finish', sessionID: 'root', part: {reason: 'length'}},
    ]);
    await expect(runOpenCodeWithMcp(options)).rejects.toMatchObject({
      category: 'execution_failed',
      message: expect.stringContaining('completed assistant turn'),
    });
  });

  it('rejects a redirected invalid mock attempt', async () => {
    const {options} = await fixture();
    const invalid = tool('invalid');
    invalid.part.state.input = {tool: 'linear_get_issue'} as never;
    options.input.env.DXB_EVENTS = JSON.stringify([invalid, ...answer()]);
    await expect(runOpenCodeWithMcp(options)).rejects.toMatchObject({
      category: 'execution_failed',
      message: expect.stringContaining('rejected arguments'),
    });
  });

  it.each(['Issue missing', 'Permission denied: missing issue access'])(
    'retains service error "%s" without inferring infrastructure failure',
    async (message) => {
      const {options} = await fixture();
      const event = tool();
      Object.assign(event.part.state, {status: 'error', error: message});
      options.input.env.DXB_EVENTS = JSON.stringify([event, ...answer()]);
      expect((await runOpenCodeWithMcp(options)).toolEvents).toContainEqual(
        expect.objectContaining({
          rawName: 'mcp__linear__get_issue',
          status: 'failure',
          message,
        }),
      );
    },
  );

  it.each(['child-single', 'child-paged', 'child-nested'])(
    'retains %s tool evidence and the parent answer',
    async (mode) => {
      const {options} = await fixture(mode);
      options.input.env.DXB_CHILD_HISTORY = JSON.stringify([childMessage()]);
      options.input.env.DXB_EVENTS = JSON.stringify([
        tool(),
        ...answer('Parent answer'),
      ]);
      const result = await runOpenCodeWithMcp(options);
      expect(result.toolEvents?.map((event) => event.input)).toEqual(
        mode === 'child-nested'
          ? [{id: 2}, {id: 2}, {id: 1}]
          : [{id: 2}, {id: 1}],
      );
      expect(
        new OpenCodeHarness().extractResult(result.output).finalMessage,
      ).toBe('Parent answer');
    },
  );

  it('rejects incomplete child attempts and malformed child lists', async () => {
    for (const mode of ['child-single', 'child-bad-list']) {
      const {options} = await fixture(mode);
      const message = childMessage();
      message.content[0]!.state.status = 'running';
      options.input.env.DXB_CHILD_HISTORY = JSON.stringify([message]);
      await expect(runOpenCodeWithMcp(options)).rejects.toMatchObject({
        category: 'execution_failed',
      });
    }
  });

  it('encodes IDs in child control request paths', async () => {
    const {options, records} = await fixture();
    options.input.env.DXB_SESSION_ID = 'root/a?b';
    await runOpenCodeWithMcp(options);
    expect(
      (await records()).some(
        (entry) => entry.path === '/api/session?parentID=root%2Fa%3Fb',
      ),
    ).toBe(true);
  });

  it('preserves CLI output when a tool callback fails', async () => {
    const {options} = await fixture();
    options.input.env.DXB_EVENTS = JSON.stringify([tool(), ...answer()]);
    options.input.onToolEvent = () => {
      throw new Error('callback failed');
    };
    await expect(runOpenCodeWithMcp(options)).rejects.toMatchObject({
      category: 'execution_failed',
      output: {stdout: expect.stringContaining('linear_get_issue')},
    });
  });

  it.each(['serve-hang', 'request-hang', 'cli-hang'])(
    'stops %s on timeout',
    async (mode) => {
      const {options} = await fixture(mode);
      options.input.timeoutMs = mode === 'cli-hang' ? 1000 : 500;
      await expect(runOpenCodeWithMcp(options)).rejects.toMatchObject({
        category: 'timed_out',
      });
    },
  );

  it('cancels the CLI and its owned descendants', async () => {
    const {options, root} = await fixture('run-child');
    const path = join(root, 'child.pid');
    options.input.env.DXB_PID = path;
    const abort = new AbortController();
    let pid: number | undefined;
    const pending = runOpenCodeWithMcp({
      ...options,
      input: {...options.input, signal: abort.signal},
    });
    const stopped = expect(pending).rejects.toMatchObject({
      category: 'execution_failed',
    });
    try {
      await vi.waitFor(
        async () => {
          pid = Number(await readFile(path, 'utf8'));
        },
        {timeout: 3000},
      );
      abort.abort();
      await stopped;
      await vi.waitFor(() => expect(() => process.kill(pid!, 0)).toThrow(), {
        timeout: 2500,
      });
    } finally {
      abort.abort();
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already stopped */
        }
      }
      await pending.catch(() => {});
    }
  }, 10000);
});
