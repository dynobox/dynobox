import {defineConfig} from '@dynobox/sdk';

import commitSkillConfig from './.agents/skills/commit/dyno/commit.dyno.mjs';
import releaseSkillConfig from './.agents/skills/release/dyno/release.dyno.mjs';

export default defineConfig({
  name: 'dynobox-skill-smoke-tests',
  harnesses: ['claude-code', {id: 'codex', model: 'gpt-5.4-mini'}],
  scenarios: [...commitSkillConfig.scenarios, ...releaseSkillConfig.scenarios],
});
