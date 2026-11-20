import {rm} from 'node:fs/promises';

import type {IrScenarioUser} from '@dynobox/sdk/ir';

import {errorMessage} from './diagnostics.js';
import type {
  Harness,
  HarnessResult,
  HarnessRunOutput,
} from './harnesses/index.js';
import {createWorkDir} from './workDir.js';

/** One agent turn of a multi-turn job. */
export type ConversationTurn = {
  /** The user message that started this turn. */
  prompt: string;
  finalMessage?: string;
  durationMs: number;
};

/** A multi-turn job could not continue: no user reply or no session. */
export class ConversationError extends Error {
  override readonly name = 'ConversationError';
}

/** The persona's reply that ends the conversation. */
export const USER_DONE = 'DONE';

export type NextUserMessageOptions = {
  harnesses?: readonly Harness[];
  env?: Record<string, string>;
  scratchRoot?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

/**
 * The next user message after `turns`, or `undefined` to end the
 * conversation. Scripted replies are sent in order. A persona is played by a
 * fresh, stateless harness run that sees the whole conversation so far.
 */
export async function nextUserMessage(
  user: IrScenarioUser,
  turns: readonly ConversationTurn[],
  options: NextUserMessageOptions = {},
): Promise<string | undefined> {
  if (!canReply(user, turns)) return undefined;
  if ('replies' in user) return user.replies[turns.length - 1];

  const harness = options.harnesses?.find(
    (candidate) => candidate.id === user.harness,
  );
  if (harness === undefined)
    throw new ConversationError(
      `No harness registered for simulated user harness "${user.harness}".`,
    );
  let result: HarnessResult;
  let workDir: string | undefined;
  try {
    // An empty directory keeps the persona away from the agent's workspace.
    workDir = await createWorkDir(options.scratchRoot, 'user-');
    const output = await harness.run({
      prompt: personaPrompt(user.persona, turns),
      workDir,
      env: options.env ?? {},
      ...(user.model === undefined ? {} : {model: user.model}),
      ...(options.timeoutMs === undefined
        ? {}
        : {timeoutMs: options.timeoutMs}),
      ...(options.signal === undefined ? {} : {signal: options.signal}),
    });
    result = harness.extractResult(output);
  } catch (error) {
    options.signal?.throwIfAborted();
    throw new ConversationError(
      `Simulated user (${harness.id}) failed: ${errorMessage(error)}`,
      {cause: error},
    );
  } finally {
    // Best effort: a leftover directory must not discard the reply.
    if (workDir !== undefined)
      await rm(workDir, {recursive: true, force: true}).catch(() => undefined);
  }
  if (result.exitCode !== 0)
    throw new ConversationError(
      `Simulated user (${harness.id}) exited with code ${result.exitCode}${result.errorMessage === undefined ? '' : `: ${result.errorMessage}`}.`,
    );
  const reply = result.finalMessage?.trim();
  if (!reply)
    throw new ConversationError(
      `Simulated user (${harness.id}) returned no message.`,
    );
  return isDone(reply) ? undefined : reply;
}

/** Whether `user` may send another message after `turns`. */
export function canReply(
  user: IrScenarioUser,
  turns: readonly ConversationTurn[],
): boolean {
  return 'replies' in user
    ? turns.length <= user.replies.length
    : turns.length < user.maxTurns;
}

export function personaPrompt(
  persona: string,
  turns: readonly ConversationTurn[],
): string {
  const transcript = turns
    .flatMap((turn) => [
      `[user]\n${turn.prompt}`,
      `[agent]\n${turn.finalMessage?.trim() || '(no message)'}`,
    ])
    .join('\n\n');
  return [
    'You are role-playing the user in a conversation with an AI coding agent. Stay in character.',
    `<persona>\n${persona}\n</persona>`,
    `<conversation>\n${transcript}\n</conversation>`,
    'Write your next message to the agent. Reply with the message text only.',
    'If what the agent did does not match what you want, tell it what to change.',
    `Reply with exactly ${USER_DONE} only once the agent has done what you want, or has nothing left to ask you.`,
    "Do not use tools or do the agent's work yourself.",
  ].join('\n\n');
}

function isDone(reply: string): boolean {
  return (
    reply.replace(/^[\s"'`*]+|[\s"'`*.!]+$/g, '').toUpperCase() === USER_DONE
  );
}

/** Combine per-turn raw output for debug rendering. */
export function mergeTurnOutputs(
  outputs: readonly HarnessRunOutput[],
): HarnessRunOutput {
  const last = outputs.at(-1)!;
  if (outputs.length === 1) return last;
  return {
    ...last,
    stdout: outputs.map((output) => output.stdout).join('\n'),
    stderr: outputs
      .map((output) => output.stderr)
      .filter(Boolean)
      .join('\n'),
    durationMs: sum(outputs.map((output) => output.durationMs)),
  };
}

/**
 * Assertions see the whole conversation: every turn's tool events and
 * transcript, and the last turn's final message and exit status.
 */
export function mergeTurnResults(
  results: readonly HarnessResult[],
): HarnessResult {
  const last = results.at(-1)!;
  if (results.length === 1) return last;
  return {
    ...last,
    durationMs: sum(results.map((result) => result.durationMs)),
    transcript: results.map((result) => result.transcript).join('\n'),
    toolEvents: results.flatMap((result) => result.toolEvents),
  };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
