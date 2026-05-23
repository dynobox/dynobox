import {getAllDocs, getDoc, getDocFileBySlug} from '../lib/docs';

export async function getStaticPaths() {
  const docs = await getAllDocs();

  return docs
    .filter((doc) => doc.slug)
    .map((doc) => ({
      params: {slug: doc.slug},
    }));
}

export async function GET({params}: {params: {slug?: string}}) {
  const file = getDocFileBySlug(params.slug);
  const doc = await getDoc(file);

  return new Response(`${doc.source.trim()}\n`, {
    headers: {'content-type': 'text/markdown; charset=utf-8'},
  });
}
