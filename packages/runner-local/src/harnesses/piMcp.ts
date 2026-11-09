import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {
  mcpDeadline,
  McpHarnessError,
  requireMcpVersion,
} from '../mcpMocks/errors.js';
import {mcpProxyEnv} from '../mcpMocks/proxyEnv.js';
import {startOwnedProcess} from '../processGroup.js';
import {isRecord} from './parsing.js';
import {
  buildPiArgs,
  parsePiJson,
  parsePiJsonLine,
  PI_BLANK_PROMPT,
  type PiMcpTools,
} from './pi.js';
import {lineSplitter, ToolEventLineStream} from './runStreamingHarness.js';
import type {
  HarnessInput,
  HarnessRunOutput,
  McpHarnessRun,
  McpServerConnections,
} from './types.js';

// Keep prompt, session, and adapter configuration under the runner's control.
const VALUE_FLAGS = new Set([
  '--thinking',
  '--tools',
  '-t',
  '--exclude-tools',
  '-xt',
  '--provider',
  '--model',
  '--api-key',
  '--system-prompt',
  '--append-system-prompt',
  '--skill',
]);
// `--no-tools` is excluded because it also disables the mock tools.
const SWITCH_FLAGS = new Set([
  '--no-builtin-tools',
  '-nbt',
  '--no-skills',
  '-ns',
  '--no-prompt-templates',
  '-np',
  '--no-themes',
  '--no-context-files',
  '-nc',
  '--verbose',
  '--offline',
  '--no-extensions',
  '-ne',
]);
const MIN_MCP_VERSION = '1.5.0';
const READY_MARKER = 'DYNOBOX_MCP_READY ';
const CONFIG_ERROR_MARKER = 'DYNOBOX_MCP_CONFIG_ERROR:';
const NOT_READY_MARKER = 'DYNOBOX_MCP_NOT_READY:';

export async function runPiWithMcp(options: {
  executable: string;
  input: HarnessInput;
  servers: McpServerConnections;
  extraArgs?: readonly string[];
}): Promise<McpHarnessRun> {
  const started = Date.now();
  const {input, servers, executable} = options;
  if (input.prompt.trim() === '')
    throw new McpHarnessError('configuration_failed', PI_BLANK_PROMPT);
  const remaining = mcpDeadline(input.timeoutMs, input.signal);
  const extraArgs = options.extraArgs ?? [];
  for (let index = 0; index < extraArgs.length; index++) {
    const flag = extraArgs[index]!;
    if (SWITCH_FLAGS.has(flag)) continue;
    // Pi takes the next argument as the value, even when it starts with -.
    if (VALUE_FLAGS.has(flag) && extraArgs[++index] !== undefined) continue;
    throw new McpHarnessError(
      'configuration_failed',
      `Pi extra argument ${flag} is unsupported or missing a value for MCP mocking.`,
    );
  }
  // Portable names Dynobox reports; the bridge maps Pi's native names to these.
  const expectedTools = new Set(
    Object.entries(servers).flatMap(([server, {tools}]) =>
      tools.map((tool) => `mcp__${server}__${tool}`),
    ),
  );
  const identities = Object.keys(servers).map((name) =>
    name.replace(/-/g, '_'),
  );
  if (new Set(identities).size !== identities.length)
    throw new McpHarnessError(
      'configuration_failed',
      'Pi MCP server names must remain distinct after hyphen normalization.',
    );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...input.env,
    PI_OFFLINE: '1',
  };
  Object.assign(env, mcpProxyEnv(env));
  const processOptions = {
    cwd: input.workDir,
    env,
    extendEnv: false,
    reject: false as const,
    ...(input.signal === undefined ? {} : {cancelSignal: input.signal}),
  };
  const probe = await startOwnedProcess(executable, ['--version'], {
    ...processOptions,
    stdin: 'ignore',
    timeout: Math.min(5000, remaining()),
  });
  let version: string;
  try {
    remaining();
    version = requireMcpVersion('Pi', MIN_MCP_VERSION, probe);
    if (!version.startsWith('1.'))
      throw new McpHarnessError(
        'unsupported_version',
        'Pi MCP mocks require Pi 1.5.0 or a later 1.x release.',
      );
  } catch (error) {
    if (error instanceof McpHarnessError)
      throw new McpHarnessError(error.category, error.message, {
        exitCode: probe.exitCode ?? 1,
        stdout: probe.stdout,
        stderr: probe.stderr,
        durationMs: probe.durationMs,
      });
    throw error;
  }

  const directory = await mkdtemp(join(tmpdir(), 'dynobox-pi-mcp-'));
  let output: HarnessRunOutput | undefined;
  try {
    const bridge = join(directory, 'bridge.mjs');
    await writeFile(bridge, piBridgeSource(servers));
    let mcpTools: PiMcpTools = {};
    let ready = false;
    const buffered: string[] = [];
    const toolInputs = new Map<string, unknown>();
    const child = startOwnedProcess(
      executable,
      buildPiArgs(
        ['--no-mcp', '-e', bridge, ...extraArgs],
        input.model,
        input.permissionMode,
      ),
      {...processOptions, input: input.prompt, timeout: remaining()},
    );
    let callbackFailure: McpHarnessError | undefined;
    const stream = new ToolEventLineStream({
      parseLine: (line, lineNumber) =>
        parsePiJsonLine(line, lineNumber, toolInputs, mcpTools),
      onToolEvent: (event) => {
        if (callbackFailure !== undefined) return;
        try {
          input.onToolEvent?.(event);
        } catch (error) {
          callbackFailure = new McpHarnessError(
            'execution_failed',
            `Pi tool-event callback failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          child.stop();
        }
      },
    });
    const readiness = lineSplitter((line) => {
      if (!line.startsWith(READY_MARKER) || callbackFailure) return;
      try {
        const value: unknown = JSON.parse(line.slice(READY_MARKER.length));
        if (!isRecord(value))
          throw new Error('Invalid Pi MCP readiness metadata.');
        const tools: Record<string, string> = {};
        for (const [name, logical] of Object.entries(value)) {
          if (
            !name.startsWith('mcp__') ||
            typeof logical !== 'string' ||
            !expectedTools.has(logical)
          )
            throw new Error('Invalid Pi MCP tool identity.');
          tools[name] = logical;
        }
        const available = new Set(Object.values(tools));
        if ([...expectedTools].some((name) => !available.has(name)))
          throw new Error('Pi did not activate every declared MCP mock tool.');
        mcpTools = tools;
        ready = true;
        for (const chunk of buffered.splice(0)) stream.write(chunk);
      } catch (error) {
        callbackFailure = new McpHarnessError(
          'not_ready',
          error instanceof Error ? error.message : String(error),
        );
        child.stop();
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => readiness.write(chunk));
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (ready) stream.write(chunk);
      else buffered.push(chunk);
    });
    const result = await child;
    readiness.flush();
    stream.flush();
    output = {
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - started,
      metadata: {piMcpTools: mcpTools},
    };
    if (callbackFailure !== undefined) throw callbackFailure;
    remaining();
    if (result.timedOut)
      throw new McpHarnessError('timed_out', 'MCP run exceeded its timeout.');
    const configError = result.stderr
      .split('\n')
      .find((line) => line.startsWith(CONFIG_ERROR_MARKER));
    if (configError)
      throw new McpHarnessError(
        'configuration_failed',
        configError.slice(CONFIG_ERROR_MARKER.length).trim(),
      );
    const notReady = result.stderr
      .split('\n')
      .find((line) => line.startsWith(NOT_READY_MARKER));
    if (notReady !== undefined)
      throw new McpHarnessError(
        'not_ready',
        notReady.slice(NOT_READY_MARKER.length).trim(),
      );
    // Startup failures such as a bridge that fails to load end here. Pi's
    // stderr stays in the debug output rather than the diagnostic.
    if (!ready)
      throw new McpHarnessError(
        'not_ready',
        'Pi exited before the native MCP mocks were ready.',
      );
    if (result.failed || output.exitCode !== 0)
      throw new McpHarnessError(
        'execution_failed',
        `Pi exited with code ${result.exitCode ?? 'unknown'}.`,
      );
    const parsed = parsePiJson(result.stdout, mcpTools);
    // JSON mode always prints a session header, so empty stdout means Pi
    // never ran the session.
    if (parsed.terminalFailure || result.stdout.trim() === '')
      throw new McpHarnessError(
        'execution_failed',
        parsed.errorMessage ?? 'Pi finished without output.',
      );
    return {
      harnessReady: true,
      version,
      output,
      toolEvents: parsed.toolEvents,
    };
  } catch (error) {
    if (output !== undefined)
      throw new McpHarnessError(
        error instanceof McpHarnessError ? error.category : 'execution_failed',
        error instanceof Error ? error.message : String(error),
        output,
      );
    throw error;
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

// The installed Pi SDK supplies transport, credentials, tool registration and
// protocol semantics. This extension only changes configuration and readiness.

function piBridgeSource(servers: McpServerConnections): string {
  return `
import * as nativeSdk from '@earendil-works/pi-coding-agent';
import {existsSync,realpathSync,writeSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const mocks = ${JSON.stringify(servers)};
const tools = {};
const fail = (ctx, message, config = false) => {
 writeSync(2, (config ? ${JSON.stringify(CONFIG_ERROR_MARKER)} : ${JSON.stringify(NOT_READY_MARKER)}) + ' ' + message + '\\n');
 ctx.abort();
};
export default async function(pi) {
 let source;
 let configurationError;
 let unsupported='Pi MCP mocks require an npm installation of Pi 1.5.0 or newer with its native MCP SDK.';
 try {
  source = realpathSync(fileURLToPath(import.meta.url));
  const {createMcpExtension,getAgentDir,getPackageDir} = nativeSdk;
  // Pi does not export loadMcpConfig, so a later 1.x release can move it.
  // Standalone Bun builds never ship it; an npm installation missing it is a newer layout.
  const loader = join(getPackageDir(),'dist','extensions','mcp','config.js');
  if(!process.versions.bun&&!existsSync(loader))
   unsupported='This Pi release does not include the MCP configuration loader Dynobox uses ('+loader+').';
  const {loadMcpConfig} = await import(pathToFileURL(loader).href);
  const identity = (name) => name.replace(/-/g, '_');
  const checkStdio = (entries) => {
   const targets = new Set(Object.keys(mocks).map(identity));
   for (const entry of entries) if(targets.has(identity(entry.name)) && 'command' in entry.config && entry.config.enabled !== false)
    configurationError='Pi MCP target "'+entry.name+'" uses stdio; selective mocking supports HTTP targets.';
  };
  // Registry changes may come from any inherited lifecycle hook.
  pi.on('mcp_servers_change',(_event,ctx)=>{
   checkStdio(pi.getMcpServers());
   if(configurationError)fail(ctx,configurationError,true);
  });
  createMcpExtension({startupWaitMs:5000,loadConfig(ctx) {
   const loaded = loadMcpConfig({agentDir:getAgentDir(),cwd:ctx.cwd,projectTrusted:ctx.isProjectTrusted()});
   const targets = new Set(Object.keys(mocks).map(identity));
   checkStdio([...loaded.servers,...pi.getMcpServers()]);
   return {...loaded,servers:[...loaded.servers.filter(entry=>!targets.has(identity(entry.name))),
    ...Object.entries(mocks).map(([server,connection])=>({name:server,config:{url:connection.url,exposure:'direct'},scope:'extension',source:'dynobox MCP mocks'}))]};
  }})({...pi,
   // Preserve user commands; only the native MCP tools are needed in headless runs.
   registerCommand(name,command) {if(name!=='mcp')pi.registerCommand(name,command);},
   registerTool(definition) {
    for(const [server,connection] of Object.entries(mocks)) {
     const prefix=server+'/';
     if(definition.label?.startsWith(prefix)) {
      const tool=definition.label.slice(prefix.length);
      if(connection.tools.includes(tool)) {
       tools[definition.name]='mcp__'+server+'__'+tool;
       const execute=definition.execute;
       definition={...definition,async execute(...args) {
        const result=await execute(...args);
        const full=result.structuredContent;
        if(full?.structuredContent===undefined)return result;
        // Keep JSON visible beside text, matching existing Dynobox mock responses.
        return {...result,content:[...(full.content?.length?result.content:[]),{type:'text',text:JSON.stringify(full.structuredContent)}]};
       }};
      }
     }
    }
    pi.registerTool(definition);
   }
  });
  // Inherited session_start handlers may register targets after loadConfig.
  pi.on('agent_start',(_event,ctx)=>{
   checkStdio(pi.getMcpServers());
   if(configurationError)return fail(ctx,configurationError,true);
   const active = new Set(pi.getActiveTools());
   const all = pi.getAllTools();
   for(const [server,connection] of Object.entries(mocks))for(const tool of connection.tools) {
    const name=Object.keys(tools).find(name=>tools[name]==='mcp__'+server+'__'+tool);
    const registered=all.find(item=>item.name===name);
    let owned=false;
    try {owned=realpathSync(registered?.sourceInfo.path)===source;}catch{}
    if(!name||!active.has(name)||!owned)return fail(ctx,'Pi did not activate MCP mock tool "'+server+'/'+tool+'" under an unambiguous native identity.');
   }
   writeSync(2,${JSON.stringify(READY_MARKER)}+JSON.stringify(tools)+'\\n');
  });
 } catch(error) {
  writeSync(2,String(error)+'\\n');
  configurationError=unsupported;
 }
  pi.on('before_agent_start', (event,ctx) => {
   if(configurationError)return fail(ctx,configurationError,true);
   // Mocks use direct exposure, which skips codemode's describeNamespace()
   // where Pi exposes server instructions, so add them here. Other servers
   // keep Pi's native exposure and instructions.
   const all = pi.getAllTools();
   const guidance=[];
   for(const server of Object.keys(mocks)) {
    const namespace=all.find(tool=>tool.namespace?.aliases?.includes(server))?.namespace;
    if(namespace?.instructions)guidance.push('MCP server '+server+':\\n'+namespace.instructions);
   }
   if(guidance.length)event.systemPromptOptions.appendSystemPrompt=[event.systemPromptOptions.appendSystemPrompt,...guidance].filter(Boolean).join('\\n\\n');
  });
}
`;
}
