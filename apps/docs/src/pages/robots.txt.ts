import {docsSite} from '../lib/docs';

export function GET() {
  const lines = [
    'User-agent: *',
    'Allow: /',
    'Content-Signal: ai-train=yes, search=yes, ai-input=yes',
    `Sitemap: ${new URL('/sitemap.xml', docsSite).toString()}`,
    `LLMs: ${new URL('/llms.txt', docsSite).toString()}`,
  ];

  return new Response(`${lines.join('\n')}\n`, {
    headers: {'content-type': 'text/plain; charset=utf-8'},
  });
}
