import type {HttpMethod} from './http-method.js';

/**
 * The author-facing shape passed to `http.endpoint`.
 *
 * `headers`, `body`, and `response` are reserved for future runner features
 * (request shaping, mocking) and are accepted today even though the M1
 * runner does not consume them.
 */
export type EndpointSpec = {
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  response?: {
    status?: number;
    headers?: Record<string, string>;
    body?: unknown;
  };
};
