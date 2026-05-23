import {getDoc} from '../lib/docs';

export async function GET() {
  const doc = await getDoc('README.md');

  return new Response(`${doc.source.trim()}\n`, {
    headers: {'content-type': 'text/markdown; charset=utf-8'},
  });
}
