import type {EndpointSpec} from './endpoint-spec.js';

/**
 * Internal brand symbols. Endpoint and assertion objects can only be
 * produced by the SDK helpers — users cannot hand-author them. This keeps
 * the IR a compile target rather than a hand-written format and lets us
 * change internal shapes without breaking authors.
 */
const ENDPOINT_BRAND = Symbol.for('@dynobox/sdk/endpoint');
const ASSERTION_BRAND = Symbol.for('@dynobox/sdk/assertion');

export type Endpoint = EndpointSpec & {
  readonly [ENDPOINT_BRAND]: true;
};

export type CalledAssertion<K extends string = string> = {
  readonly [ASSERTION_BRAND]: true;
  readonly kind: 'http.called';
  readonly endpoint: K;
  readonly status?: number;
};

export type NotCalledAssertion<K extends string = string> = {
  readonly [ASSERTION_BRAND]: true;
  readonly kind: 'http.notCalled';
  readonly endpoint: K;
};

export type Assertion<K extends string = string> =
  | CalledAssertion<K>
  | NotCalledAssertion<K>;

/**
 * Constructs a branded endpoint. Internal — call via `http.endpoint`.
 *
 * @param spec The author-supplied endpoint shape.
 * @returns A branded endpoint object.
 */
export function brandEndpoint(spec: EndpointSpec): Endpoint {
  return {...spec, [ENDPOINT_BRAND]: true} as Endpoint;
}

/**
 * Constructs a branded `http.called` assertion. Internal — call via
 * `http.called`.
 *
 * @param endpoint The endpoint key being asserted on.
 * @param opts Optional assertion modifiers (e.g. `status`).
 * @returns A branded `http.called` assertion.
 */
export function brandCalled<K extends string>(
  endpoint: K,
  opts?: {status?: number},
): CalledAssertion<K> {
  const base = {
    [ASSERTION_BRAND]: true as const,
    kind: 'http.called' as const,
    endpoint,
  };
  return opts?.status === undefined
    ? (base as CalledAssertion<K>)
    : ({...base, status: opts.status} as CalledAssertion<K>);
}

/**
 * Constructs a branded `http.notCalled` assertion. Internal — call via
 * `http.notCalled`.
 *
 * @param endpoint The endpoint key being asserted on.
 * @returns A branded `http.notCalled` assertion.
 */
export function brandNotCalled<K extends string>(
  endpoint: K,
): NotCalledAssertion<K> {
  return {
    [ASSERTION_BRAND]: true as const,
    kind: 'http.notCalled' as const,
    endpoint,
  };
}
