import {docsSite, getAllDocs} from '../lib/docs';

export async function GET() {
  const docs = await getAllDocs();
  const routes = [
    ...docs.flatMap((doc) => [doc.route, doc.markdownRoute]),
    '/llms.txt',
    '/llms-full.txt',
    '/docs-index.json',
  ];

  const urls = routes
    .map((route) => new URL(route, docsSite).toString())
    .map(
      (url) => `  <url>
    <loc>${escapeXml(url)}</loc>
  </url>`,
    )
    .join('\n');

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;

  return new Response(`${body}\n`, {
    headers: {'content-type': 'application/xml; charset=utf-8'},
  });
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (char) => {
    switch (char) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case "'":
        return '&apos;';
      case '"':
        return '&quot;';
      default:
        return char;
    }
  });
}
