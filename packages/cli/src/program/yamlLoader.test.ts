import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {compile, resolveConfigModule} from '@dynobox/sdk/compiler';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import {loadDyno} from './configLoader.js';
import {loadYamlDyno, YamlDynoParseError} from './yamlLoader.js';

const ROOT = join(process.cwd(), '.tmp-dynobox-cli-tests-yaml');

const VALID_YAML = `name: yaml-quickstart
harnesses:
  - claude-code
scenarios:
  - id: inspect-package
    name: inspect package scripts
    prompt: Read package.json and report scripts.
    setup:
      - "echo '{}' > package.json"
    assertions:
      - id: reads-package
        label: reads package.json
        type: tool.called
        tool: shell
      - type: tool.called
        tool: shell
        command:
          includes: package.json
      - type: anyOf
        steps:
          - type: tool.called
            tool: read_file
            path: package.json
          - type: command.called
            executable: cat
            command:
              args: [package.json]
      - type: artifact.exists
        path: package.json
      - type: verify.command
        command: node --version
        exitCode: 0
        stdout:
          startsWith: v
`;

const MALFORMED_YAML = `name: bad
scenarios:
  - name: oops
    prompt: "missing close
`;

const BAD_TYPE_YAML = `name: bad-type
harnesses: ['claude-code']
scenarios:
  - name: bogus
    prompt: hi
    assertions:
      - type: tool.cAlLeD
        tool: shell
`;

function writeFile(name: string, body: string): string {
  const file = join(ROOT, name);
  writeFileSync(file, body);
  return file;
}

describe('loadYamlDyno', () => {
  beforeAll(() => {
    rmSync(ROOT, {force: true, recursive: true});
    mkdirSync(ROOT, {recursive: true});
  });

  afterAll(() => {
    rmSync(ROOT, {force: true, recursive: true});
  });

  it('parses a valid YAML dyno into the same shape compile() expects', async () => {
    const file = writeFile('valid.dyno.yaml', VALID_YAML);

    const loaded = await loadYamlDyno(file);
    const config = resolveConfigModule(loaded);
    const ir = compile(config);

    expect(ir.name).toBe('yaml-quickstart');
    expect(ir.scenarios).toHaveLength(1);
    const scenario = ir.scenarios[0];
    if (scenario === undefined) throw new Error('expected scenario');
    expect(scenario.name).toBe('inspect package scripts');
    expect(scenario.id).toBe('scenario.inspect-package');
    expect(scenario.assertions[0]).toMatchObject({
      id: 'assertion.inspect-package.reads-package',
      label: 'reads package.json',
    });
    expect(scenario.assertions[3]).toMatchObject({
      kind: 'artifact.exists',
      path: 'package.json',
    });
    expect(scenario.assertions[2]).toMatchObject({
      kind: 'anyOf',
      steps: [
        {
          kind: 'tool.called',
          toolKind: 'read_file',
          pathMatcher: {path: 'package.json'},
        },
        {
          kind: 'command.called',
          executable: 'cat',
          matcher: {args: ['package.json']},
        },
      ],
    });
    expect(scenario.assertions[4]).toMatchObject({
      kind: 'verify.command',
      command: 'node --version',
      exitCode: 0,
      stdout: {startsWith: 'v'},
    });
    expect(scenario.assertions.length).toBeGreaterThanOrEqual(4);
  });

  it('throws YamlDynoParseError with a line:column pointer on malformed YAML', async () => {
    const file = writeFile('malformed.dyno.yaml', MALFORMED_YAML);

    await expect(loadYamlDyno(file)).rejects.toMatchObject({
      name: 'YamlDynoParseError',
      message: expect.stringMatching(/malformed\.dyno\.yaml:\d+:\d+/),
    });
  });

  it('lets the SDK schema reject an invalid assertion type', async () => {
    const file = writeFile('bad-type.dyno.yaml', BAD_TYPE_YAML);
    const loaded = await loadYamlDyno(file);
    // resolveConfigModule runs the full schema, so it rejects bad types
    // before compile() ever gets called.
    expect(() => resolveConfigModule(loaded)).toThrow();
  });
});

describe('loadDyno suffix dispatch', () => {
  beforeAll(() => {
    rmSync(ROOT, {force: true, recursive: true});
    mkdirSync(ROOT, {recursive: true});
  });

  afterAll(() => {
    rmSync(ROOT, {force: true, recursive: true});
  });

  it('routes .yaml files through the YAML loader', async () => {
    const file = writeFile('dispatch.dyno.yaml', VALID_YAML);

    const loaded = (await loadDyno(file)) as {default: unknown};
    expect(loaded).toHaveProperty('default');
    const config = resolveConfigModule(loaded);
    expect(() => compile(config)).not.toThrow();
  });

  it('throws YamlDynoParseError when a .yml file is malformed', async () => {
    const file = writeFile('dispatch-bad.dyno.yml', MALFORMED_YAML);

    await expect(loadDyno(file)).rejects.toBeInstanceOf(YamlDynoParseError);
  });

  it('routes .ts files through the tsx-based loader', async () => {
    const file = join(ROOT, 'dispatch.dyno.ts');
    writeFileSync(
      file,
      `import {defineDyno, tool} from '@dynobox/sdk';
export default defineDyno({
  name: 'ts-dispatch',
  harnesses: ['claude-code'],
  scenarios: [
    {
      name: 'noop',
      prompt: 'do nothing',
      assertions: [tool.notCalled('shell')],
    },
  ],
});
`,
    );

    const loaded = await loadDyno(file);
    const config = resolveConfigModule(loaded);
    const ir = compile(config);
    expect(ir.name).toBe('ts-dispatch');
  });
});
