export function GET() {
  return new Response(`${JSON.stringify({status: 'ok'})}\n`, {
    headers: {'content-type': 'application/json; charset=utf-8'},
  });
}
