import {describe, expect, it} from 'vitest';

import {scenarioSchema} from './configSchema.js';
import {irScenarioUserSchema, scenarioUserSchema} from './user.js';

describe('scenarioUserSchema', () => {
  it.each([
    {replies: ['UUID keys please.']},
    {persona: 'A backend developer who wants UUID keys.'},
    {
      persona: 'A backend developer.',
      harness: 'codex',
      model: 'gpt-5-mini',
      maxTurns: 3,
    },
  ])('accepts user %#', (user) => {
    expect(scenarioUserSchema.safeParse(user).success).toBe(true);
  });

  it.each([
    {},
    {replies: []},
    {replies: ['  ']},
    {replies: Array.from({length: 20}, () => 'again')},
    {persona: ''},
    {persona: 'Someone.', maxTurns: 1},
    {persona: 'Someone.', maxTurns: 21},
    {persona: 'Someone.', maxTurns: 2.5},
    {persona: 'Someone.', harness: 'not-a-harness'},
    {persona: 'Someone.', replies: ['Both.']},
    {replies: ['Hi.'], maxTurns: 3},
  ])('rejects invalid user %#', (user) => {
    expect(scenarioUserSchema.safeParse(user).success).toBe(false);
  });

  it('is accepted on a scenario', () => {
    expect(
      scenarioSchema.safeParse({
        name: 'multi-turn',
        prompt: 'Add a users table.',
        user: {replies: ['UUID keys.']},
      }).success,
    ).toBe(true);
  });
});

describe('irScenarioUserSchema', () => {
  it('requires resolved persona defaults', () => {
    expect(irScenarioUserSchema.safeParse({persona: 'Someone.'}).success).toBe(
      false,
    );
    expect(
      irScenarioUserSchema.safeParse({
        persona: 'Someone.',
        harness: 'claude-code',
        maxTurns: 5,
      }).success,
    ).toBe(true);
  });
});
