import {
  absoluteDocsUrl,
  dynoboxDocsSkill,
  sha256Digest,
} from '../../../lib/agentDiscovery';

export function GET() {
  const index = {
    $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json',
    skills: [
      {
        name: 'dynobox-docs',
        type: 'skill-md',
        description:
          'Use the Dynobox documentation site to answer questions about installing, configuring, running, and debugging Dynobox agent workflow tests.',
        url: absoluteDocsUrl('/.well-known/agent-skills/dynobox-docs/SKILL.md'),
        digest: sha256Digest(dynoboxDocsSkill),
      },
    ],
  };

  return new Response(`${JSON.stringify(index, null, 2)}\n`, {
    headers: {'content-type': 'application/json; charset=utf-8'},
  });
}
