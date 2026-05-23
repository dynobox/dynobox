import type {IrAssertion} from '@dynobox/sdk/ir';

import {stringsFromUnknown} from './inspection.js';
import {failed} from './results.js';
import type {AssertionResult, ToolEvent} from './types.js';

export function evaluateSkillInvoked(
  assertion: Extract<IrAssertion, {kind: 'skill.invoked'}>,
  toolEvents: readonly ToolEvent[],
): AssertionResult {
  const event = toolEvents.find((toolEvent) =>
    toolEventMentionsSkillFile(toolEvent, assertion.skill),
  );

  if (event !== undefined) {
    return {
      assertionId: assertion.id,
      kind: assertion.kind,
      passed: true,
      message: `Observed skill "${assertion.skill}" instruction file access.`,
      evidence: event,
    };
  }

  return failed(
    assertion,
    `Expected skill "${assertion.skill}" to be invoked, but no access to its SKILL.md was observed.`,
  );
}

function toolEventMentionsSkillFile(
  event: ToolEvent,
  skillName: string,
): boolean {
  return stringsFromUnknown(event).some((value) =>
    stringMentionsSkillFile(value, skillName),
  );
}

function stringMentionsSkillFile(value: string, skillName: string): boolean {
  const normalized = value.replaceAll('\\', '/').toLowerCase();
  const normalizedSkill = skillName.toLowerCase();
  return [
    `.agents/skills/${normalizedSkill}/skill.md`,
    `.claude/skills/${normalizedSkill}/skill.md`,
  ].some((path) => normalized.includes(path));
}
