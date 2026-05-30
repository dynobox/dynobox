import {Hono} from 'hono';

type Bindings = {
  DB: D1Database;
};

type ErrorCode = 'internal_error' | 'not_found' | 'not_implemented';

type ErrorStatus = 404 | 500 | 501;

export const app = new Hono<{Bindings: Bindings}>();

function jsonError(
  status: ErrorStatus,
  code: ErrorCode,
  message: string,
): Response {
  return Response.json({error: {code, message}}, {status});
}

function notImplemented(feature: string): Response {
  return jsonError(
    501,
    'not_implemented',
    `${feature} is not implemented yet.`,
  );
}

app.get('/health', (context) => context.json({ok: true}));

app.post('/runs', () => notImplemented('Run upload'));
app.get('/runs', () => notImplemented('Run listing'));
app.get('/runs/:id', () => notImplemented('Run lookup'));
app.patch('/runs/:id', () => notImplemented('Run update'));
app.post('/cli-tokens', () => notImplemented('CLI token minting'));

app.notFound(() => jsonError(404, 'not_found', 'Route not found.'));

app.onError((error) => {
  console.error(error);
  return jsonError(500, 'internal_error', 'Internal server error.');
});

export default app;
