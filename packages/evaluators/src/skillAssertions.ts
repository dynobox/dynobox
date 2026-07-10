import type {IrAssertion} from '@dynobox/sdk/ir';

import {stringsFromUnknown} from './inspection.js';
import {failed, passed} from './results.js';
import type {AssertionResult, ToolEvent} from './types.js';

export function evaluateSkillReferenced(
  assertion: Extract<IrAssertion, {type: 'skill.referenced'}>,
  toolEvents: readonly ToolEvent[],
): AssertionResult {
  const event = toolEvents.find(
    (toolEvent) =>
      toolEventMentionsSkillFile(toolEvent, assertion.skill) ||
      toolEventInvokesSkill(toolEvent, assertion.skill),
  );

  if (event !== undefined) {
    return passed(
      assertion,
      `Observed skill "${assertion.skill}" instruction file reference.`,
      event,
    );
  }

  return failed(
    assertion,
    `Expected skill "${assertion.skill}" to be referenced, but no reference to its SKILL.md was observed.`,
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

function toolEventInvokesSkill(event: ToolEvent, skillName: string): boolean {
  if (event.rawName.toLowerCase() !== 'skill') return false;
  if (typeof event.input !== 'object' || event.input === null) return false;

  const invokedSkill = (event.input as {skill?: unknown}).skill;
  return (
    typeof invokedSkill === 'string' &&
    invokedSkill.toLowerCase() === skillName.toLowerCase()
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
