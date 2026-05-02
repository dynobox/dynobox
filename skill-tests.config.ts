import {defineConfig} from '@dynobox/sdk';

import commitSkillConfig from './.agents/skills/commit/dyno/commit.dyno.js';
import releaseSkillConfig from './.agents/skills/release/dyno/release.dyno.js';

export default defineConfig({
  name: 'dynobox-skill-smoke-tests',
  scenarios: [...commitSkillConfig.scenarios, ...releaseSkillConfig.scenarios],
});
