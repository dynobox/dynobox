import {describe, expect, it} from 'vitest';

import {
  canReply,
  ConversationError,
  mergeTurnOutputs,
  mergeTurnResults,
  nextUserMessage,
  personaPrompt,
} from './conversation.js';
import {FakeHarness} from './harnesses/fake.js';
import type {HarnessResult} from './harnesses/index.js';

const turns = [{prompt: 'Add a users table.', finalMessage: 'Key type?'}].map(
  (turn) => ({...turn, durationMs: 1}),
);
const persona = {
  persona: 'Wants UUID keys.',
  harness: 'claude-code' as const,
  maxTurns: 3,
};

describe('nextUserMessage', () => {
  it('sends scripted replies in order, then ends', async () => {
    const user = {replies: ['First.', 'Second.']};
    await expect(nextUserMessage(user, turns)).resolves.toBe('First.');
    await expect(nextUserMessage(user, [...turns, ...turns])).resolves.toBe(
      'Second.',
    );
    await expect(
      nextUserMessage(user, [...turns, ...turns, ...turns]),
    ).resolves.toBeUndefined();
  });

  it.each(['DONE', 'DONE.', '`DONE`', '"DONE!"', '**DONE**', 'Done.', 'done'])(
    'ends the conversation when the persona replies %j',
    async (reply) => {
      await expect(
        nextUserMessage(persona, turns, {
          harnesses: [new FakeHarness({stdout: reply})],
        }),
      ).resolves.toBeUndefined();
    },
  );

  it('returns the trimmed persona reply', async () => {
    await expect(
      nextUserMessage(persona, turns, {
        harnesses: [new FakeHarness({stdout: '  UUIDs. Done for now?\n'})],
      }),
    ).resolves.toBe('UUIDs. Done for now?');
  });

  it('does not run the persona once maxTurns is reached', async () => {
    await expect(
      nextUserMessage({...persona, maxTurns: 1}, turns),
    ).resolves.toBeUndefined();
  });

  it.each([
    [{}, [], 'No harness registered for simulated user harness "claude-code".'],
    [
      {stdout: ''},
      undefined,
      'Simulated user (claude-code) returned no message.',
    ],
    [
      {exitCode: 3},
      undefined,
      'Simulated user (claude-code) exited with code 3.',
    ],
  ])('reports a persona failure %#', async (response, harnesses, message) => {
    await expect(
      nextUserMessage(persona, turns, {
        harnesses: harnesses ?? [new FakeHarness(response)],
      }),
    ).rejects.toThrow(new ConversationError(message));
  });

  it('reports a persona harness that throws', async () => {
    const harness = new FakeHarness();
    harness.run = async () => {
      throw new Error('spawn claude ENOENT');
    };
    await expect(
      nextUserMessage(persona, turns, {harnesses: [harness]}),
    ).rejects.toThrow(
      new ConversationError(
        'Simulated user (claude-code) failed: spawn claude ENOENT',
      ),
    );
  });
});

describe('canReply', () => {
  it('allows one reply per scripted message', () => {
    const user = {replies: ['First.']};
    expect(canReply(user, turns)).toBe(true);
    expect(canReply(user, [...turns, ...turns])).toBe(false);
  });

  it('allows persona replies until maxTurns', () => {
    expect(canReply({...persona, maxTurns: 2}, turns)).toBe(true);
    expect(canReply({...persona, maxTurns: 2}, [...turns, ...turns])).toBe(
      false,
    );
  });
});

describe('personaPrompt', () => {
  it('includes the persona, the conversation, and the stop word', () => {
    const prompt = personaPrompt('Wants UUID keys.', [
      ...turns,
      {prompt: 'UUIDs.', durationMs: 1},
    ]);

    expect(prompt).toContain('<persona>\nWants UUID keys.\n</persona>');
    expect(prompt).toContain(
      '[user]\nAdd a users table.\n\n[agent]\nKey type?\n\n[user]\nUUIDs.\n\n[agent]\n(no message)',
    );
    expect(prompt).toContain('Reply with exactly DONE only once');
  });
});

describe('merging turns', () => {
  const result = (turn: number): HarnessResult => ({
    exitCode: turn === 2 ? 1 : 0,
    durationMs: 5,
    transcript: `transcript ${turn}`,
    finalMessage: `message ${turn}`,
    toolEvents: [{kind: 'unknown', rawName: `tool${turn}`, input: {}}],
    sessionId: 'session-1',
  });

  it('keeps a single turn unchanged', () => {
    const only = result(1);
    expect(mergeTurnResults([only])).toBe(only);
  });

  it('combines transcripts and tools, keeping the last turn outcome', () => {
    expect(mergeTurnResults([result(1), result(2)])).toEqual({
      exitCode: 1,
      durationMs: 10,
      transcript: 'transcript 1\ntranscript 2',
      finalMessage: 'message 2',
      toolEvents: [
        {kind: 'unknown', rawName: 'tool1', input: {}},
        {kind: 'unknown', rawName: 'tool2', input: {}},
      ],
      sessionId: 'session-1',
    });
  });

  it('combines raw output for debug rendering', () => {
    expect(
      mergeTurnOutputs([
        {exitCode: 0, stdout: 'a', stderr: '', durationMs: 1},
        {exitCode: 2, stdout: 'b', stderr: 'oops', durationMs: 2},
      ]),
    ).toEqual({exitCode: 2, stdout: 'a\nb', stderr: 'oops', durationMs: 3});
  });
});
