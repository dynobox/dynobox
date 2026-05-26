import {absoluteDocsUrl} from '../../lib/agentDiscovery';

export function GET() {
  const catalog = {
    linkset: [
      {
        anchor: absoluteDocsUrl('/'),
        'service-desc': [
          {
            href: absoluteDocsUrl('/docs-index.json'),
            type: 'application/json',
          },
          {
            href: absoluteDocsUrl('/llms.txt'),
            type: 'text/plain',
          },
        ],
        'service-doc': [
          {
            href: absoluteDocsUrl('/'),
            type: 'text/html',
          },
          {
            href: absoluteDocsUrl('/README.md'),
            type: 'text/markdown',
          },
        ],
        status: [
          {
            href: absoluteDocsUrl('/health.json'),
            type: 'application/json',
          },
        ],
      },
    ],
  };

  return new Response(`${JSON.stringify(catalog, null, 2)}\n`, {
    headers: {
      'content-type': 'application/linkset+json; charset=utf-8',
    },
  });
}
