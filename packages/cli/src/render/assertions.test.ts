import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import type {LocalRunnerJob, LocalRunnerResult} from '@dynobox/runner-local';
import {describe, expect, it} from 'vitest';

import {assertionByIdForJobs} from '../jobs.js';
import {createRenderContext} from '../terminal/index.js';
import {renderAssertionDetails} from './assertions.js';

describe('renderAssertionDetails', () => {
  it('shows assertion labels before assertion descriptions', () => {
    const job = {
      id: 'job.1',
      scenario: {
        id: 'scenario.labels',
        name: 'labels',
        prompt: 'p',
        harnesses: [{id: 'claude-code'}],
        setup: [],
        fixtures: [],
        endpoints: [],
        assertions: [
          {
            id: 'assertion.labels.reads-package',
            label: 'reads package.json',
            kind: 'tool.called',
            toolKind: 'shell',
          },
        ],
      },
      harness: 'claude-code',
      iteration: 0,
    } satisfies LocalRunnerJob;
    const result = {
      assertionResults: [
        {
          assertionId: 'assertion.labels.reads-package',
          kind: 'tool.called',
          passed: true,
          message: 'Observed tool "shell".',
        },
      ],
      harnessResult: {toolEvents: []},
    } as unknown as LocalRunnerResult;

    expect(
      renderAssertionDetails(
        result,
        assertionByIdForJobs([job]),
        createRenderContext({usePlainSymbols: true}, {verbose: true}),
      ),
    ).toContain('[ ok ] reads package.json  tool.called(shell)');
  });

  it('shows the observed final message excerpt when finalMessage.contains fails', () => {
    const job = {
      id: 'job.1',
      scenario: {
        id: 'scenario.final-message',
        name: 'final message',
        prompt: 'p',
        harnesses: [{id: 'claude-code'}],
        setup: [],
        fixtures: [],
        endpoints: [],
        assertions: [
          {
            id: 'assertion.final-message.contains',
            kind: 'finalMessage.contains',
            text: 'does not invalidate the original matrix failure',
          },
        ],
      },
      harness: 'claude-code',
      iteration: 0,
    } satisfies LocalRunnerJob;
    const result = {
      assertionResults: [
        {
          assertionId: 'assertion.final-message.contains',
          kind: 'finalMessage.contains',
          passed: false,
          message:
            'Expected final message to contain "does not invalidate the original matrix failure".',
        },
      ],
      harnessResult: {
        toolEvents: [],
        finalMessage:
          'Original run preserved. Matrix signal points at the codex failed job.',
      },
    } as unknown as LocalRunnerResult;

    const output = renderAssertionDetails(
      result,
      assertionByIdForJobs([job]),
      createRenderContext({usePlainSymbols: true}, {}),
    );

    expect(output).toContain(
      'expected  final message containing "does not invalidate the original matrix failure"',
    );
    expect(output).toContain(
      'observed  final message: "Original run preserved. Matrix signal points at the codex failed job."',
    );
    expect(output).not.toContain('observed  Expected final message to contain');
  });

  it('shows observed evidence for failed non-text assertions', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'dynobox-render-'));
    writeFileSync(join(workDir, 'output.txt'), 'actual artifact contents');

    const job = {
      id: 'job.1',
      scenario: {
        id: 'scenario.evidence',
        name: 'evidence',
        prompt: 'p',
        harnesses: [{id: 'claude-code'}],
        setup: [],
        fixtures: [],
        endpoints: [],
        assertions: [
          {
            id: 'assertion.tool.called',
            kind: 'tool.called',
            toolKind: 'read_file',
            pathMatcher: {path: 'missing.txt'},
          },
          {
            id: 'assertion.tool.not-called',
            kind: 'tool.notCalled',
            toolKind: 'shell',
            matcher: {includes: 'pnpm test'},
          },
          {
            id: 'assertion.skill.referenced',
            kind: 'skill.referenced',
            skill: 'dyno-debug',
          },
          {
            id: 'assertion.http.not-called',
            kind: 'http.notCalled',
            endpointId: 'endpoint.test.getUser',
          },
          {
            id: 'assertion.artifact.contains',
            kind: 'artifact.contains',
            path: 'output.txt',
            text: 'expected text',
          },
        ],
      },
      harness: 'claude-code',
      iteration: 0,
    } satisfies LocalRunnerJob;
    const shellEvent = {
      kind: 'shell',
      rawName: 'shell',
      input: {command: 'pnpm test'},
      command: 'pnpm test',
    };
    const readFileEvent = {
      kind: 'read_file',
      rawName: 'read_file',
      input: {path: 'other.txt'},
    };
    const httpEvent = {
      endpointId: 'endpoint.test.getUser',
      method: 'GET',
      url: 'https://api.example.test/users/1',
      host: 'api.example.test',
      timestamp: '2026-05-22T00:00:00.000Z',
      status: 200,
    };
    const result = {
      workDir,
      httpEvents: [httpEvent],
      assertionResults: [
        {
          assertionId: 'assertion.tool.called',
          kind: 'tool.called',
          passed: false,
          message:
            'Expected tool "read_file" with path "missing.txt" to be called, but observed none.',
        },
        {
          assertionId: 'assertion.tool.not-called',
          kind: 'tool.notCalled',
          passed: false,
          message:
            'Expected no shell command matching includes "pnpm test", but observed a matching command.',
          evidence: shellEvent,
        },
        {
          assertionId: 'assertion.skill.referenced',
          kind: 'skill.referenced',
          passed: false,
          message:
            'Expected skill "dyno-debug" to be referenced, but no reference to its SKILL.md was observed.',
        },
        {
          assertionId: 'assertion.http.not-called',
          kind: 'http.notCalled',
          passed: false,
          message:
            'Expected HTTP endpoint "endpoint.test.getUser" not to be called, but observed a matching request.',
          evidence: httpEvent,
        },
        {
          assertionId: 'assertion.artifact.contains',
          kind: 'artifact.contains',
          passed: false,
          message: 'Expected artifact "output.txt" to contain "expected text".',
        },
      ],
      harnessResult: {
        toolEvents: [readFileEvent, shellEvent],
      },
    } as unknown as LocalRunnerResult;

    const output = renderAssertionDetails(
      result,
      assertionByIdForJobs([job]),
      createRenderContext({usePlainSymbols: true}, {}),
    );

    expect(output).toContain(
      'observed  1 read_file tool call observed, none for path "missing.txt"',
    );
    expect(output).toContain('observed  matching shell command "pnpm test"');
    expect(output).toContain(
      'observed  no matching SKILL.md reference observed',
    );
    expect(output).toContain(
      'observed  matching request: GET https://api.example.test/users/1 -> 200',
    );
    expect(output).toContain('observed  artifact: "actual artifact contents"');
    expect(output).not.toContain('observed  Expected');
  });
});
