import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {parseOpenCodeJson} from './opencode.js';
import {
  prepareOpenCodeMcpConfiguration,
  runOpenCodeWithMcp,
} from './opencodeMcp.js';
import type {HarnessInput} from './types.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, {recursive: true, force: true});
});

/** Start a CLI fixture with the v2 HTTP contract and controlled failure responses. */
async function fixture(mode = 'success') {
  const root = await mkdtemp(join(tmpdir(), 'dynobox-opencode-v2-'));
  roots.push(root);
  const executable = join(root, 'opencode.mjs');
  const log = join(root, 'requests.jsonl');
  await writeFile(
    executable,
    `#!${process.execPath}
import {appendFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
const args = process.argv.slice(2);
const mode = process.env.DXB_MODE;
const record = value => appendFileSync(process.env.DXB_LOG, JSON.stringify(value) + '\\n');
record({args, noProxy: process.env.no_proxy, NO_PROXY: process.env.NO_PROXY});
console.error('PRIVATE_STDERR_SENTINEL');
if (mode === 'hang' || args.includes('serve') && mode === 'serve-hang') {
 if (process.env.DXB_PID) spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(process.env.DXB_PID,String(process.pid));setInterval(()=>{},1000)'], {stdio:'inherit'});
 setInterval(()=>{},1000);
} else if (args.includes('--version')) console.log(process.env.DXB_VERSION || '2.2.5');
else if (mode === 'serve-exit') {console.log('PRIVATE_STDOUT_SENTINEL');process.exit(2);}
else {
 const inline = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
 let permissionsStarted = false;
 let replied = false;
 let agentReads = 0;
 let mcpReads = 0;
 let prompted = false;
 const server = createServer(async (request,response) => {
  let body='';for await (const chunk of request) body+=chunk;
  record({path:request.url, body:body ? JSON.parse(body) : undefined, authenticated:request.headers.authorization === 'Basic '+Buffer.from('opencode:'+process.env.OPENCODE_PASSWORD).toString('base64')});
  const path=request.url;
  if(path==='/api/permission/request') {
   permissionsStarted=true;
   if(mode==='permission-hang') return;
  }
  let result = {};
  if(path==='/api/config') result = mode==='bad-config' ? {} : [{type:'document',info:inline}, ...(mode==='org-policy' ? [{type:'document',info:{policies:[{action:'plugin.use',resource:'*',effect:'allow'}]}}] : [])];
  if(path==='/api/plugin') result={data: mode==='plugin' || mode==='late-plugin' && prompted ? [{source:{type:'package',target:'external'},state:{status:'active'}}] : [{source:{type:'builtin'},state:{status:'active'}}]};
  if(path.endsWith('/prompt')) prompted=true;
  if(path==='/api/agent') result = {data: mode==='agent-pending' && agentReads++===0 ? [] : [{id:'build', permissions: JSON.parse(process.env.DXB_RULES || '[]')}]};
  if(path==='/api/mcp') result = {data: [{name:'linear', status:{status:mode==='disconnected' ? 'failed' : mode==='mcp-pending' && mcpReads++===0 ? 'pending' : 'connected'}}, ...(mode==='inherited' ? [{name:'real',status:{status:'connected'}}] : [])]};
  if(path.startsWith('/api/session?')) result={data: mode==='child-bad-list' ? {} : path==='/api/session?parentID=test' && mode.startsWith('child-') ? [{id:'child'}] : path==='/api/session?parentID=child' && mode==='child-nested' ? [{id:'nested'},{id:'test'}] : [], cursor:{next:null,previous:null}};
  if(mode==='child-paged' && path.startsWith('/api/session?')) result={data:path.includes('cursor=page2') ? [{id:'child'}] : [],cursor:{next:path==='/api/session?parentID=test' ? 'page2' : null,previous:null}};
  if(path==='/api/session') result={data:{id:process.env.DXB_SESSION_ID || 'test'}};
  if(path==='/api/permission/request') result={data:(mode==='reject-length' || mode==='reject-mock') && !replied ? [{id:'per_test',sessionID:'test',action:mode==='reject-mock' ? 'linear_get_issue' : 'shell'}] : []};
  if(path.endsWith('/reply')) {replied=true;response.writeHead(204).end();return;}
  if(path.endsWith('/wait')) {
   if(mode==='request-hang') return;
   while (!permissionsStarted || (mode==='reject-length' || mode==='reject-mock') && !replied) await new Promise(r=>setTimeout(r,5));
   response.writeHead(204).end();return;
  }
  if(path.endsWith('/export')) {
   const tool = {type:'tool',id:'call_1',name:'linear_get_issue',state:{status:'error',input:{id:'1'},error:{message:'Issue missing'}}};
   const childHistory = (path.includes('/child/') || path.includes('/nested/')) && mode==='child-nested' ? [{type:'assistant',id:path,finish:'stop',content:[tool]}] : path.includes('/child/') && mode==='child-invalid' ? [{type:'assistant',id:'child-msg',finish:'stop',content:[{type:'tool',id:'bad',name:'invalid',state:{status:'error',input:{tool:'linear_get_issue'},error:'invalid'}}]}] : undefined;
   const messages = path.includes('/child/') && process.env.DXB_CHILD_HISTORY ? JSON.parse(process.env.DXB_CHILD_HISTORY) : childHistory || (process.env.DXB_HISTORY ? JSON.parse(process.env.DXB_HISTORY) : [{type:'assistant', id:'msg_1', finish: (mode==='reject-length' || mode==='reject-mock') ? 'length' : 'stop', content:mode==='tool-error' ? [tool] : [{type:'text',text:'OK'}]}]);
   result={data:{info:{outcome:mode==='model-error' ? 'failed' : 'succeeded'},messages}};
  }
  if(mode==='permission-error' && path==='/api/permission/request' || mode==='http-error' && path==='/api/mcp') {response.writeHead(503).end();return;}
  response.setHeader('Content-Type','application/json');
  response.end(mode==='bad-json' && path==='/api/mcp' ? 'not JSON' : JSON.stringify(result));
 });
 server.listen(0,'127.0.0.1',()=>{
  const port=String(server.address().port);
  if(mode==='split-port') {process.stdout.write('http://127.0.0.1:'+port.slice(0,2));setTimeout(()=>process.stdout.write(port.slice(2)+'\\n'),40);}
  else console.log('http://127.0.0.1:'+port);
 });
}
`,
    {mode: 0o700},
  );
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
      XDG_CONFIG_HOME: join(root, '.config'),
      XDG_DATA_HOME: join(root, '.data'),
      XDG_CACHE_HOME: join(root, '.cache'),
      XDG_STATE_HOME: join(root, '.state'),
      DXB_MODE: mode,
      DXB_LOG: log,
      OPENCODE_CONFIG_CONTENT: '{}',
      NO_PROXY: 'one.example',
      no_proxy: 'two.example',
    },
  };
  return {
    options: {
      executable,
      input,
      servers: {linear: {url: 'http://127.0.0.1:1/mcp', tools: ['get_issue']}},
    },
    log,
    root,
  };
}
const history = (content: unknown, finish = 'stop') => [
  {type: 'assistant', id: 'msg_1', finish, content},
];

describe('OpenCode v2 MCP preparation', () => {
  it.each(['plugin.use', 'mcp.use', '*', 'integration.*'])(
    'rejects unsafe action %s from every policy source',
    async (action) => {
      for (const inline of [true, false]) {
        const {options, root, log} = await fixture();
        const config = {
          experimental: {policies: [{action, resource: '*', effect: 'allow'}]},
        };
        if (inline)
          options.input.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
        else
          await writeFile(join(root, 'opencode.jsonc'), JSON.stringify(config));
        await expect(
          prepareOpenCodeMcpConfiguration(options),
        ).rejects.toMatchObject({category: 'configuration_failed'});
        await expect(readFile(log)).rejects.toMatchObject({code: 'ENOENT'});
      }
    },
  );
  it('checks the normal global directory when a custom directory is set', async () => {
    const {options, root, log} = await fixture();
    options.input.env.OPENCODE_CONFIG_DIR = join(root, 'custom');
    options.input.env.XDG_CONFIG_HOME = join(root, '.config');
    const directory = join(root, '.config', 'opencode');
    await mkdir(directory, {recursive: true});
    await writeFile(
      join(directory, 'config.json'),
      JSON.stringify({
        policies: [{action: 'mcp.use', resource: '*', effect: 'allow'}],
      }),
    );
    await expect(
      prepareOpenCodeMcpConfiguration(options),
    ).rejects.toMatchObject({category: 'configuration_failed'});
    await expect(readFile(log)).rejects.toMatchObject({code: 'ENOENT'});
  });
  it.each(['', 'relative-config'])(
    'resolves global config against the child cwd (XDG_CONFIG_HOME=%j)',
    async (xdg) => {
      const {options, root} = await fixture();
      options.input.env.XDG_CONFIG_HOME = xdg;
      const directory = join(root, xdg || '.config', 'opencode');
      await mkdir(directory, {recursive: true});
      await writeFile(
        join(directory, 'config.json'),
        JSON.stringify({
          policies: [{action: 'plugin.use', resource: '*', effect: 'allow'}],
        }),
      );
      await expect(
        prepareOpenCodeMcpConfiguration(options),
      ).rejects.toMatchObject({category: 'configuration_failed'});
    },
  );
  it('caps the version probe without a job timeout', async () => {
    const {options} = await fixture('hang');
    delete options.input.timeoutMs;
    await expect(
      prepareOpenCodeMcpConfiguration(options),
    ).rejects.toMatchObject({
      category: 'timed_out',
      message: 'OpenCode version check exceeded its timeout.',
      output: {stderr: expect.stringContaining('PRIVATE_STDERR_SENTINEL')},
    });
  }, 10000);
  it.each([
    'fixture/fixture#',
    'fixture/#fast',
    '/fixture',
    'fixture/model#fast#extra',
  ])('rejects invalid model %s before launch', async (model) => {
    const {options, log} = await fixture();
    options.input.model = model;
    await expect(runOpenCodeWithMcp(options)).rejects.toMatchObject({
      category: 'configuration_failed',
    });
    await expect(readFile(log)).rejects.toMatchObject({code: 'ENOENT'});
  });
  it.each(['1.18.26', '1.99.0', '2.0.32', '2.2.4', '3.0.0'])(
    'rejects unsupported release %s',
    async (version) => {
      const {options} = await fixture();
      options.input.env.DXB_VERSION = version;
      await expect(runOpenCodeWithMcp(options)).rejects.toMatchObject({
        category: 'unsupported_version',
      });
    },
  );
  it.each(['', '{ /* comment */ "model":"fixture/model", }'])(
    'accepts OpenCode inline configuration %j',
    async (config) => {
      const {options} = await fixture();
      options.input.env.OPENCODE_CONFIG_CONTENT = config;
      const prepared = await prepareOpenCodeMcpConfiguration(options);
      expect(prepared.version).toBe('2.2.5');
      expect(
        JSON.parse(prepared.env.OPENCODE_CONFIG_CONTENT!).mcp.servers.linear,
      ).toMatchObject({codemode: false, oauth: false});
    },
  );
  it.each(['{broken', '[]', 'null'])(
    'reports invalid inline configuration %s',
    async (config) => {
      const {options, log} = await fixture();
      options.input.env.OPENCODE_CONFIG_CONTENT = config;
      await expect(runOpenCodeWithMcp(options)).rejects.toMatchObject({
        category: 'configuration_failed',
      });
      await expect(readFile(log)).rejects.toMatchObject({code: 'ENOENT'});
    },
  );
  it.each([
    {
      mcp: {
        servers: {linear: {type: 'remote', url: 'https://real.example/mcp'}},
      },
    },
    {
      policies: [
        {action: 'integration.use', resource: 'mcp:*', effect: 'allow'},
      ],
    },
    {
      policies: [
        {action: 'integration.use', resource: 'plugin:*', effect: 'allow'},
      ],
    },
  ])('rejects file configuration that defeats isolation %#', async (config) => {
    const {options, root, log} = await fixture();
    await writeFile(join(root, 'opencode.json'), JSON.stringify(config));
    await expect(runOpenCodeWithMcp(options)).rejects.toMatchObject({
      category: 'configuration_failed',
    });
    await expect(readFile(log)).rejects.toMatchObject({code: 'ENOENT'});
  });
  it.each(['servers', 'timeout'])(
    'does not treat the native %s section as a server name',
    async (name) => {
      const {options, root} = await fixture();
      await writeFile(
        join(root, 'opencode.json'),
        JSON.stringify({
          mcp: {
            servers: {other: {type: 'remote', url: 'https://real.example/mcp'}},
            timeout: {startup: 1000},
          },
        }),
      );
      await expect(
        prepareOpenCodeMcpConfiguration({
          ...options,
          servers: {[name]: {url: 'http://127.0.0.1:1/mcp', tools: ['lookup']}},
        }),
      ).resolves.toHaveProperty('version', '2.2.5');
    },
  );
  it('rejects colliding mock tool names', async () => {
    const {options} = await fixture();
    await expect(
      prepareOpenCodeMcpConfiguration({
        ...options,
        servers: {
          a_b: {url: 'http://localhost', tools: ['c']},
          a: {url: 'http://localhost', tools: ['b_c']},
        },
      }),
    ).rejects.toMatchObject({category: 'configuration_failed'});
  });
  it('does not accept extra launch arguments', async () => {
    const {options, log} = await fixture();
    await expect(
      runOpenCodeWithMcp({...options, extraArgs: ['--agent', 'other']}),
    ).rejects.toMatchObject({category: 'configuration_failed'});
    await expect(readFile(log)).rejects.toMatchObject({code: 'ENOENT'});
  });
});

describe('OpenCode v2 MCP execution', () => {
  it.each(['org-policy', 'plugin', 'late-plugin'])(
    'rejects runtime isolation bypasses (%s)',
    async (mode) => {
      const {options} = await fixture(mode);
      await expect(runOpenCodeWithMcp(options)).rejects.toMatchObject({
        category: 'configuration_failed',
      });
    },
  );
  it('shows mock permission guidance before reporting the finish reason', async () => {
    const {options} = await fixture('reject-mock');
    await expect(runOpenCodeWithMcp(options)).rejects.toThrow('Allow the tool');
  });
  it('orders parent and child tool calls by execution time', async () => {
    const {options} = await fixture('child-custom');
    const tool = (id: string, time: number) => ({
      type: 'tool',
      id,
      name: 'linear_get_issue',
      time: {created: time - 1, ran: time},
      state: {status: 'completed', input: {id}},
    });
    options.input.env.DXB_HISTORY = JSON.stringify(
      history([tool('before', 10), tool('after', 30)]),
    );
    options.input.env.DXB_CHILD_HISTORY = JSON.stringify([
      {
        type: 'assistant',
        id: 'child-msg',
        finish: 'stop',
        content: [tool('between', 20)],
      },
    ]);
    const result = await runOpenCodeWithMcp(options);
    expect(result.toolEvents?.map((event) => event.input)).toEqual([
      {id: 'before'},
      {id: 'between'},
      {id: 'after'},
    ]);
  });
  it('allows the parent to recover from a failed child', async () => {
    const {options} = await fixture('child-custom');
    options.input.env.DXB_CHILD_HISTORY = JSON.stringify([
      {
        type: 'assistant',
        id: 'child-msg',
        finish: 'error',
        error: {message: 'child failed'},
        content: [],
      },
    ]);
    await expect(runOpenCodeWithMcp(options)).resolves.toMatchObject({
      harnessReady: true,
    });
  });
  it('does not substitute child or earlier parent text for a textless final turn', async () => {
    const {options} = await fixture('child-custom');
    options.input.env.DXB_HISTORY = JSON.stringify([
      {
        type: 'assistant',
        id: 'earlier',
        finish: 'stop',
        content: [{type: 'text', text: 'Earlier parent'}],
      },
      ...history([]),
    ]);
    options.input.env.DXB_CHILD_HISTORY = JSON.stringify([
      {
        type: 'assistant',
        id: 'child-msg',
        finish: 'stop',
        content: [{type: 'text', text: 'Child answer'}],
      },
    ]);
    const result = await runOpenCodeWithMcp(options);
    expect(
      parseOpenCodeJson(result.output.stdout).finalMessage,
    ).toBeUndefined();
  });
  it('encodes session IDs in control request paths', async () => {
    const {options, log} = await fixture();
    const id = 'session/with ?#%';
    options.input.env.DXB_SESSION_ID = id;
    await runOpenCodeWithMcp(options);
    const paths = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).path);
    expect(paths).toEqual(
      expect.arrayContaining([
        `/api/session/${encodeURIComponent(id)}/prompt`,
        `/api/experimental/session/${encodeURIComponent(id)}/wait`,
        `/api/experimental/session/${encodeURIComponent(id)}/export`,
      ]),
    );
  });
  it('sends the model variant separately', async () => {
    const {options, log} = await fixture();
    options.input.model = 'fixture/fixture#fast';
    await runOpenCodeWithMcp(options);
    const requests = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(
      requests.find((entry) => entry.path === '/api/session').body.model,
    ).toEqual({providerID: 'fixture', id: 'fixture', variant: 'fast'});
  });
  it('rejects invalid mock arguments in a child session', async () => {
    const {options} = await fixture('child-invalid');
    await expect(runOpenCodeWithMcp(options)).rejects.toThrow(
      'rejected arguments',
    );
  });
  it('collects nested child attempts once', async () => {
    const {options} = await fixture('child-nested');
    const result = await runOpenCodeWithMcp(options);
    expect(result.toolEvents).toHaveLength(2);
    expect(
      result.toolEvents?.every(
        (event) => event.rawName === 'mcp__linear__get_issue',
      ),
    ).toBe(true);
  });
  it('reads all child session pages', async () => {
    const {options, log} = await fixture('child-paged');
    await runOpenCodeWithMcp(options);
    expect(await readFile(log, 'utf8')).toContain(
      '/api/experimental/session/child/export',
    );
  });
  it('fails when the child list is invalid', async () => {
    const {options} = await fixture('child-bad-list');
    await expect(runOpenCodeWithMcp(options)).rejects.toThrow(
      'invalid child sessions',
    );
  });
  it('accepts recovery after an earlier assistant error', async () => {
    const {options} = await fixture();
    options.input.env.DXB_HISTORY = JSON.stringify([
      {type: 'assistant', id: 'failed', error: {message: 'retry'}, content: []},
      ...history([{type: 'text', text: 'Recovered'}]),
    ]);
    await expect(runOpenCodeWithMcp(options)).resolves.toMatchObject({
      harnessReady: true,
    });
  });
  it.each(['success', 'split-port', 'agent-pending', 'mcp-pending'])(
    'uses authenticated v2 control requests (%s)',
    async (mode) => {
      const {options, log} = await fixture(mode);
      const result = await runOpenCodeWithMcp(options);
      expect(result).toMatchObject({
        harnessReady: true,
        version: '2.2.5',
        output: {exitCode: 0},
      });
      expect(result.output.stdout).toContain('OK');
      const requests = (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(requests.filter((r) => r.path).every((r) => r.authenticated)).toBe(
        true,
      );
      expect(
        requests.find((r) => r.args?.includes('serve')).args,
      ).not.toContain('--pure');
      expect(requests[0].NO_PROXY).toContain('127.0.0.1');
      expect(requests[0].noProxy).toContain('two.example');
    },
  );
  it.each([
    ['disconnected', 'not_ready'],
    ['inherited', 'configuration_failed'],
    ['bad-config', 'configuration_failed'],
    ['http-error', 'execution_failed'],
    ['bad-json', 'execution_failed'],
    ['model-error', 'execution_failed'],
    ['serve-exit', 'execution_failed'],
  ] as const)('rejects %s', async (mode, category) => {
    const {options} = await fixture(mode);
    await expect(runOpenCodeWithMcp(options)).rejects.toMatchObject({category});
  });
  it.each([
    ['linear_?et_issue', 'deny'],
    ['linear_??et_issue', 'allow'],
  ] as const)(
    'matches configured permission pattern %s',
    async (pattern, expected) => {
      const {options} = await fixture();
      options.input.env.DXB_RULES = JSON.stringify([
        {action: pattern, resource: '*', effect: 'deny'},
      ]);
      const pending = runOpenCodeWithMcp(options);
      if (expected === 'deny')
        await expect(pending).rejects.toMatchObject({category: 'not_ready'});
      else await expect(pending).resolves.toHaveProperty('harnessReady', true);
    },
  );
  it('preserves model and ordered grants in session permissions', async () => {
    const {options, log} = await fixture();
    options.input.model = 'fixture/model';
    options.input.permissionMode = 'dangerous';
    options.input.allowedMcpTools = [{server: 'linear', tool: 'get_issue'}];
    options.input.env.DXB_RULES = JSON.stringify([
      {action: 'shell', resource: '*', effect: 'deny'},
    ]);
    await runOpenCodeWithMcp(options);
    const requests = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const session = requests.find((r) => r.path === '/api/session').body;
    expect(session.model).toEqual({providerID: 'fixture', id: 'model'});
    expect(session.permissions).toContainEqual({
      action: 'shell',
      resource: '*',
      effect: 'deny',
    });
    expect(session.permissions).toContainEqual({
      action: 'linear_get_issue',
      resource: '*',
      effect: 'allow',
    });
    expect(session.permissions.at(-1)).toEqual({
      action: 'question',
      resource: '*',
      effect: 'deny',
    });
  });
  it('does not excuse a length finish after an unrelated rejection', async () => {
    const {options} = await fixture('reject-length');
    await expect(runOpenCodeWithMcp(options)).rejects.toMatchObject({
      category: 'execution_failed',
      message: 'OpenCode finished with length.',
    });
  });
  it.each([true, false])(
    'cancels a stalled permission request (job timeout: %s)',
    async (timed) => {
      const {options} = await fixture('permission-hang');
      if (!timed) delete options.input.timeoutMs;
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 3000);
      try {
        await expect(
          runOpenCodeWithMcp({
            ...options,
            input: {...options.input, signal: abort.signal},
          }),
        ).resolves.toHaveProperty('harnessReady', true);
      } finally {
        clearTimeout(timer);
      }
    },
  );
  it('fails a broken permission poll without a job deadline', async () => {
    const {options} = await fixture('permission-error');
    delete options.input.timeoutMs;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 3000);
    try {
      await expect(
        runOpenCodeWithMcp({
          ...options,
          input: {...options.input, signal: abort.signal},
        }),
      ).rejects.toMatchObject({
        category: 'execution_failed',
        message: 'OpenCode /api/permission/request returned HTTP 503.',
      });
    } finally {
      clearTimeout(timer);
    }
  });
  it('preserves tool inputs, failure messages, and unique call IDs', async () => {
    const {options} = await fixture('tool-error');
    const result = await runOpenCodeWithMcp(options);
    expect(result.toolEvents).toEqual([
      expect.objectContaining({
        kind: 'mcp',
        rawName: 'mcp__linear__get_issue',
        input: {id: '1'},
        status: 'failure',
        message: expect.stringContaining('Issue missing'),
      }),
    ]);
  });
  it('deduplicates repeated tool parts', async () => {
    const {options} = await fixture();
    const tool = {
      type: 'tool',
      id: 'call_1',
      name: 'linear_get_issue',
      state: {status: 'completed', input: {}},
    };
    options.input.env.DXB_HISTORY = JSON.stringify(history([tool, tool]));
    expect((await runOpenCodeWithMcp(options)).toolEvents).toHaveLength(1);
  });
  it('detects a mock attempt redirected to invalid', async () => {
    const {options} = await fixture();
    options.input.env.DXB_HISTORY = JSON.stringify(
      history([
        {
          type: 'tool',
          name: 'invalid',
          id: 'call_1',
          state: {
            status: 'error',
            input: {tool: 'linear_get_issue'},
            error: 'bad arguments',
          },
        },
      ]),
    );
    await expect(runOpenCodeWithMcp(options)).rejects.toMatchObject({
      category: 'execution_failed',
      message: expect.stringContaining('before it reached the mock'),
    });
  });
  it.each([
    {},
    [],
    [null],
    [{type: 'assistant', id: 'msg_1', content: {}}],
    history([{type: 'text'}]),
    history([null]),
    history([
      {
        type: 'tool',
        id: 'call_1',
        name: 'linear_get_issue',
        state: {status: 'unknown', input: {}},
      },
    ]),
    history([
      {
        type: 'tool',
        id: 'call_1',
        name: 'linear_get_issue',
        state: {status: 'error'},
      },
    ]),
  ])('rejects malformed history %#', async (messages) => {
    const {options} = await fixture();
    options.input.env.DXB_HISTORY = JSON.stringify(messages);
    await expect(runOpenCodeWithMcp(options)).rejects.toMatchObject({
      category: 'execution_failed',
    });
  });
  it('keeps the transcript when a tool callback fails', async () => {
    const {options} = await fixture('tool-error');
    await expect(
      runOpenCodeWithMcp({
        ...options,
        input: {
          ...options.input,
          onToolEvent: () => {
            throw new Error('callback failed');
          },
        },
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('tool-event callback failed'),
      output: {stdout: expect.stringContaining('linear_get_issue')},
    });
  });
  it.each(['hang', 'serve-hang', 'request-hang'])(
    'stops %s at the shared deadline',
    async (mode) => {
      const {options} = await fixture(mode);
      options.input.timeoutMs = 350;
      await expect(runOpenCodeWithMcp(options)).rejects.toMatchObject({
        category: 'timed_out',
      });
    },
  );
  it('cancels an active model wait', async () => {
    const {options} = await fixture('request-hang');
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 250);
    try {
      await expect(
        runOpenCodeWithMcp({
          ...options,
          input: {...options.input, signal: abort.signal},
        }),
      ).rejects.toMatchObject({category: 'execution_failed'});
    } finally {
      clearTimeout(timer);
    }
  });
  it('stops owned descendants after a timeout', async () => {
    const {options, root} = await fixture('serve-hang');
    const pidPath = join(root, 'child.pid');
    options.input.env.DXB_PID = pidPath;
    options.input.timeoutMs = 700;
    await expect(runOpenCodeWithMcp(options)).rejects.toMatchObject({
      category: 'timed_out',
    });
    const pid = Number(await readFile(pidPath, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
