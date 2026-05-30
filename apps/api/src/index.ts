import {Hono} from 'hono';
import {cors} from 'hono/cors';

import {authenticateSupabaseUser, createCliToken} from './auth.js';
import type {ApiBindings} from './types.js';

type ErrorCode =
  | 'internal_error'
  | 'not_found'
  | 'not_implemented'
  | 'unauthorized';

type ErrorStatus = 401 | 404 | 500 | 501;

export const app = new Hono<{Bindings: ApiBindings}>();

app.use(
  '/cli-tokens',
  cors({
    allowHeaders: ['authorization'],
    allowMethods: ['POST', 'OPTIONS'],
    origin: ['https://dash.dynobox.xyz', 'http://localhost:5173'],
  }),
);

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
app.post('/cli-tokens', async (context) => {
  const identity = await authenticateSupabaseUser(
    context.req.raw,
    context.env,
  );
  if (identity === null) {
    return jsonError(401, 'unauthorized', 'Authentication required.');
  }

  const token = await createCliToken(context.env, identity);
  return context.json({token}, 201);
});

app.notFound(() => jsonError(404, 'not_found', 'Route not found.'));

app.onError((error) => {
  console.error(error);
  return jsonError(500, 'internal_error', 'Internal server error.');
});

export default app;
