import {dynoboxDocsSkill} from '../../../../lib/agentDiscovery';

export function GET() {
  return new Response(dynoboxDocsSkill, {
    headers: {'content-type': 'text/markdown; charset=utf-8'},
  });
}
