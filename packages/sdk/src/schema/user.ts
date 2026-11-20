import {z} from 'zod';

import {HARNESS_IDS} from '../types/harness.js';

/** Agent turns a persona conversation may run when `maxTurns` is omitted. */
export const DEFAULT_USER_MAX_TURNS = 5;
/** Upper bound on agent turns, scripted or simulated. */
export const MAX_USER_TURNS = 20;
/** Harness that plays a persona when `harness` is omitted. */
export const DEFAULT_USER_HARNESS = 'claude-code';

const repliesSchema = z
  .array(z.string().trim().min(1, 'User replies may not be blank.'))
  .min(1)
  .max(MAX_USER_TURNS - 1);

const scriptedUserSchema = z.object({replies: repliesSchema}).strict();

const personaUserSchema = z
  .object({
    persona: z.string().trim().min(1),
    harness: z.enum(HARNESS_IDS).optional(),
    model: z.string().min(1).optional(),
    maxTurns: z.number().int().min(2).max(MAX_USER_TURNS).optional(),
  })
  .strict();

/** Authored `user`: scripted replies, or a persona a harness plays. */
export const scenarioUserSchema = z.union([
  scriptedUserSchema,
  personaUserSchema,
]);

/** IR `user`, with persona defaults resolved. */
export const irScenarioUserSchema = z.union([
  scriptedUserSchema,
  personaUserSchema.required({harness: true, maxTurns: true}),
]);
