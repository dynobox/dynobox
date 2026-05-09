import {defineDyno} from '@dynobox/sdk';

import commitSkillConfig from './commit/dyno/commit.dyno.mjs';
import releaseSkillConfig from './release/dyno/release.dyno.mjs';

export default defineDyno({
  name: 'dynobox-skill-smoke-tests',
  harnesses: ['claude-code', {id: 'codex', model: 'gpt-5.4-mini'}],
  scenarios: [...commitSkillConfig.scenarios, ...releaseSkillConfig.scenarios],
});
