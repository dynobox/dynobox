import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {startMcpMockController} from '../mcpMocks/controller.js';
import {CursorHarness} from './cursor.js';
import {runCursorWithMcp} from './cursorMcp.js';

const roots: string[] = [];
const controllers: Awaited<ReturnType<typeof startMcpMockController>>[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0))
    await controller.finalize({harnessReady: true, harnessSucceeded: true});
  for (const root of roots.splice(0))
    await rm(root, {recursive: true, force: true});
});

async function fixture(mode = 'success', version = '2026.10.22-fixture') {
  const root = await mkdtemp(join(tmpdir(), 'dynobox-cursor-contract-'));
  roots.push(root);
  const work = join(root, 'work'),
    home = join(root, 'home'),
    executable = join(root, 'cursor.mjs'),
    log = join(root, 'commands.jsonl');
  await mkdir(work);
  await mkdir(join(home, '.cursor'), {recursive: true});
  const controller = await startMcpMockController({
    linear: {
      tools: {
        get_issue: {
          inputSchema: {type: 'object'},
          response: {content: [{type: 'text', text: 'ok'}]},
        },
      },
    },
  });
  controllers.push(controller);
  await writeFile(
    join(home, '.cursor', 'mcp.json'),
    '{// names only\n"mcpServers":{"linear":{"url":"https://never-connect.invalid"},"other":{"command":"never-run"}}}',
  );
  await writeFile(
    executable,
    `#!${process.execPath}
import {appendFileSync,existsSync,mkdirSync,readFileSync,writeFileSync,lstatSync} from 'node:fs';
import {basename,join} from 'node:path';
const args=process.argv.slice(2),mode=process.env.FIXTURE_MODE;
const configPath=join(process.cwd(),'.cursor','cli.json');
const state=join(process.env.CURSOR_DATA_DIR,'projects','workspace');
const disabled=join(state,'mcp-disabled.json'),auth=join(state,'mcp-auth.json');
appendFileSync(process.env.FIXTURE_LOG,JSON.stringify({args,cwd:process.cwd(),data:process.env.CURSOR_DATA_DIR,disabled:existsSync(disabled)?JSON.parse(readFileSync(disabled)):[],authLinked:existsSync(auth)&&lstatSync(auth).isSymbolicLink(),permissions:args[0]!=='--version'&&existsSync(configPath)?JSON.parse(readFileSync(configPath)).permissions:undefined})+'\\n');
if(args[0]==='--version'){console.error('SYNTHETIC_VERSION_STDERR');console.log(process.env.FIXTURE_VERSION);process.exit(0)}
if(args[0]==='mcp'){
 mkdirSync(state,{recursive:true});
 if(args[1]==='disable'){const names=existsSync(disabled)?JSON.parse(readFileSync(disabled)):[];if(!names.includes(args[2]))names.push(args[2]);writeFileSync(disabled,JSON.stringify(names))}
 if(args[1]==='list-tools')console.log('Tools for '+args[2]+' (1):\\n- '+(mode==='missing-tool'?'wrong':'get_issue')+' (id)');
 process.exit(mode==='disable-failed'&&args[1]==='disable'?1:0);
}
if(mode==='hang'){setInterval(()=>{},1000)}else if(mode==='invalid'){console.log('{invalid');setInterval(()=>{},1000)}else{
 const plugin=args[args.lastIndexOf('--plugin-dir')+1];
 const config=JSON.parse(readFileSync(join(plugin,'mcp.json')));
 const native=Object.keys(config.mcpServers).find(key=>key.startsWith('dxb_'));
 const toolArgs={providerIdentifier:native,serverIdentifier:'plugin-'+basename(plugin)+'-'+native,toolName:'get_issue',args:{literal:native+' payload',unicode:'雪é'}};
 const started={type:'tool_call',subtype:'started',call_id:'call-1',tool_call:{mcpToolCall:{args:toolArgs}}};
 const completed={...started,subtype:'completed',tool_call:{mcpToolCall:{args:toolArgs,result:{success:{content:[{text:{text:'dxb_opaque response'}}]}}}}};
 const lines=[started,...(mode==='pending'?[]:[completed,completed]),...(mode==='incomplete'?[]:[{type:'result',subtype:'success',result:'done'}])].map(value=>JSON.stringify(value)).join('\\n');
 const bytes=Buffer.from(lines),split=bytes.indexOf(Buffer.from('雪'))+1;
 process.stdout.write(bytes.subarray(0,split));setTimeout(()=>process.stdout.write(bytes.subarray(split)),5);
}
`,
    {mode: 0o755},
  );
  const options = {
    executable,
    input: {
      workDir: work,
      prompt: 'Read a receipt.',
      timeoutMs: 10000,
      env: {
        HOME: home,
        CURSOR_CONFIG_DIR: join(home, '.cursor'),
        CURSOR_DATA_DIR: join(root, 'native-data'),
        FIXTURE_MODE: mode,
        FIXTURE_VERSION: version,
        FIXTURE_LOG: log,
      },
    },
    servers: {
      linear: {
        url: controller.urls.linear!,
        tools: [mode === 'missing-tool' ? 'missing_tool' : 'get_issue'],
      },
    },
  };
  return {root, work, home, log, options};
}

describe('Cursor MCP launch contract', () => {
  it('uses one native state directory and canonical workspace, and keeps payloads opaque', async () => {
    const f = await fixture();
    const live: string[] = [];
    const result = await runCursorWithMcp({
      ...f.options,
      input: {
        ...f.options.input,
        onToolEvent: (event) => live.push(event.rawName),
      },
    });
    expect(live).toEqual(['mcp__linear__get_issue']);
    const native = Object.keys(
      result.output.metadata!.cursorMcpAliases as object,
    )[0]!;
    expect(result.toolEvents).toMatchObject([
      {
        rawName: 'mcp__linear__get_issue',
        input: {literal: native + ' payload', unicode: '雪é'},
        status: 'success',
      },
    ]);
    expect(new CursorHarness().extractResult(result.output).toolEvents).toEqual(
      result.toolEvents,
    );
    const commands = (await readFile(f.log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(commands.slice(1, 3).map(({args}) => args)).toEqual([
      ['mcp', 'disable', 'linear'],
      ['mcp', 'disable', 'linear'],
    ]);
    expect(new Set(commands.slice(1).map(({cwd}) => cwd)).size).toBe(1);
    expect(new Set(commands.slice(1).map(({data}) => data)).size).toBe(1);
    await expect(
      readFile(join(f.work, '.cursor', 'mcp.json')),
    ).rejects.toMatchObject({code: 'ENOENT'});
    await expect(lstat(commands[1].data)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it.each(['2026.10.21-fixture', 'unknown'])(
    'rejects unsupported version %s and retains its output',
    async (version) => {
      const f = await fixture('success', version);
      await expect(runCursorWithMcp(f.options)).rejects.toMatchObject({
        category: 'unsupported_version',
        output: {stdout: version, stderr: 'SYNTHETIC_VERSION_STDERR'},
      });
      expect((await readFile(f.log, 'utf8')).trim().split('\n')).toHaveLength(
        1,
      );
    },
  );

  it.each([false, true])(
    'preserves inherited permission arrays unless the project overrides them (%s)',
    async (override) => {
      const f = await fixture();
      await writeFile(
        join(f.home, '.cursor', 'cli-config.json'),
        JSON.stringify({
          permissions: {allow: ['Mcp(other:*)'], deny: ['Write(secrets/**)']},
        }),
      );
      if (override) {
        await mkdir(join(f.work, '.cursor'));
        await writeFile(
          join(f.work, '.cursor', 'cli.json'),
          JSON.stringify({permissions: {allow: ['Shell(ls)'], deny: []}}),
        );
      }
      await runCursorWithMcp(f.options);
      const command = (await readFile(f.log, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .find(({args}) => args[0] === 'mcp');
      expect(command.permissions.allow).toContain(
        override ? 'Shell(ls)' : 'Mcp(other:*)',
      );
      expect(command.permissions.deny).toEqual(
        override ? [] : ['Write(secrets/**)'],
      );
      if (override)
        expect(command.permissions.allow).not.toContain('Mcp(other:*)');
    },
  );

  it.each(['missing-tool', 'disable-failed'])(
    'does not start the task after %s preparation',
    async (mode) => {
      const f = await fixture(mode);
      await expect(runCursorWithMcp(f.options)).rejects.toMatchObject({
        category: 'not_ready',
      });
      const commands = (await readFile(f.log, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(
        commands.every(
          ({args}) => args[0] === '--version' || args[0] === 'mcp',
        ),
      ).toBe(true);
      await expect(
        readFile(join(f.work, '.cursor', 'mcp.json')),
      ).rejects.toMatchObject({code: 'ENOENT'});
    },
  );

  it('requires genuine discovery when a controller observer is available', async () => {
    const f = await fixture();
    await expect(
      runCursorWithMcp({
        ...f.options,
        servers: {
          linear: {...f.options.servers.linear, isDiscovered: () => false},
        },
      }),
    ).rejects.toMatchObject({category: 'not_ready'});
  });

  it('requires a discovery after the task process starts', async () => {
    const f = await fixture();
    await expect(
      runCursorWithMcp({
        ...f.options,
        servers: {
          linear: {...f.options.servers.linear, discoveryCount: () => 1},
        },
      }),
    ).rejects.toMatchObject({
      category: 'not_ready',
      message: expect.stringContaining('task process did not discover'),
    });
  });

  it.each(['Mcp(*:*)', 'Mcp(dxb_*:get_*)', 'Mcp(*:GET_ISSUE)'])(
    'rejects the native deny rule %s before MCP initialization',
    async (rule) => {
      const f = await fixture();
      await writeFile(
        join(f.home, '.cursor', 'cli-config.json'),
        JSON.stringify({permissions: {allow: [], deny: [rule]}}),
      );
      await expect(runCursorWithMcp(f.options)).rejects.toMatchObject({
        category: 'configuration_failed',
        message: expect.stringContaining('linear.get_issue'),
      });
      expect((await readFile(f.log, 'utf8')).trim().split('\n')).toHaveLength(
        1,
      );
    },
  );

  it.each(['Mcp(*:[g]et_issue)', 'Mcp(*:get_issu?)'])(
    'treats non-star pattern syntax literally (%s)',
    async (rule) => {
      const f = await fixture();
      await writeFile(
        join(f.home, '.cursor', 'cli-config.json'),
        JSON.stringify({permissions: {deny: [rule]}}),
      );
      expect((await runCursorWithMcp(f.options)).harnessReady).toBe(true);
    },
  );

  it('preserves unrelated disabled state and the normal native auth file', async () => {
    const f = await fixture();
    const original = join(
      f.options.input.env.CURSOR_DATA_DIR,
      'projects',
      'workspace',
    );
    await mkdir(original, {recursive: true});
    await writeFile(join(original, 'mcp-disabled.json'), '["other"]');
    await writeFile(join(original, 'mcp-auth.json'), '{}');
    await writeFile(
      join(original, 'mcp-approvals.json'),
      '["existing-approval"]',
    );
    await runCursorWithMcp(f.options);
    const commands = (await readFile(f.log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const task = commands.find(({args}) => args[0] === '-p');
    expect(task.disabled).toEqual(['other', 'linear']);
    expect(task.authLinked).toBe(true);
    expect(await readFile(join(original, 'mcp-disabled.json'), 'utf8')).toBe(
      '["other"]',
    );
    expect(await readFile(join(original, 'mcp-approvals.json'), 'utf8')).toBe(
      '["existing-approval"]',
    );
  });

  it.each(['invalid', 'incomplete', 'pending', 'hang'])(
    'rejects %s output and removes temporary overrides',
    async (mode) => {
      const f = await fixture(mode);
      await expect(
        runCursorWithMcp({
          ...f.options,
          input: {
            ...f.options.input,
            timeoutMs: mode === 'hang' ? 1500 : 10000,
          },
        }),
      ).rejects.toMatchObject({
        category: mode === 'hang' ? 'timed_out' : 'execution_failed',
      });
      await expect(
        readFile(join(f.work, '.cursor', 'cli.json')),
      ).rejects.toMatchObject({code: 'ENOENT'});
    },
  );

  it('does not follow project configuration symlinks', async () => {
    const f = await fixture();
    await mkdir(join(f.work, '.cursor'));
    const source = join(f.home, '.cursor', 'mcp.json');
    const original = await readFile(source, 'utf8');
    await symlink(source, join(f.work, '.cursor', 'cli.json'));
    await expect(runCursorWithMcp(f.options)).rejects.toMatchObject({
      category: 'configuration_failed',
      message: expect.stringContaining('symlinks'),
    });
    expect(await readFile(source, 'utf8')).toBe(original);
  });

  it('rejects conflicting arguments and cancellation before any process starts', async () => {
    const f = await fixture();
    await expect(
      runCursorWithMcp({...f.options, extraArgs: ['--workspace', '/other']}),
    ).rejects.toMatchObject({category: 'configuration_failed'});
    await expect(
      runCursorWithMcp({
        ...f.options,
        input: {...f.options.input, signal: AbortSignal.abort()},
      }),
    ).rejects.toMatchObject({category: 'execution_failed'});
    await expect(readFile(f.log)).rejects.toMatchObject({code: 'ENOENT'});
  });

  it.each(['--workspace=private-value', 'private-value'])(
    'omits unsupported argument values from diagnostics (%s)',
    async (argument) => {
      const f = await fixture();
      await expect(
        runCursorWithMcp({...f.options, extraArgs: [argument]}),
      ).rejects.toMatchObject({
        category: 'configuration_failed',
        message: expect.not.stringContaining('private-value'),
      });
      await expect(readFile(f.log)).rejects.toMatchObject({code: 'ENOENT'});
    },
  );
});
