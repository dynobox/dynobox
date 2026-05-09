import {
  createEndpoint,
  createHttpCalledAssertion,
  createHttpNotCalledAssertion,
} from '../internal/brands.js';
import type {
  CalledAssertion,
  Endpoint,
  NotCalledAssertion,
} from '../types/brands.js';
import type {EndpointSpec} from '../types/endpointSpec.js';

/**
 * Authoring helpers for HTTP endpoints and assertions.
 *
 * `endpoint` produces a branded endpoint definition. `called` and
 * `notCalled` preserve the endpoint key as a literal type so `defineDyno`
 * / `defineScenario` can verify it against the declared endpoint set at
 * compile time.
 */
export const http = {
  endpoint(spec: EndpointSpec): Endpoint {
    return createEndpoint(spec);
  },

  called<K extends string>(
    endpoint: K,
    opts?: {status?: number},
  ): CalledAssertion<K> {
    return createHttpCalledAssertion(endpoint, opts);
  },

  notCalled<K extends string>(endpoint: K): NotCalledAssertion<K> {
    return createHttpNotCalledAssertion(endpoint);
  },
};
