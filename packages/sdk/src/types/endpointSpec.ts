import type {HttpMethod} from './httpMethod.js';

/** The author-facing shape passed to `http.endpoint`. */
export type EndpointSpec = {
  method: HttpMethod;
  url: string;
};
