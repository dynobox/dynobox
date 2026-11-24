import {z} from 'zod';

import type {HttpMockRequest, HttpMockResponse} from '../types/config.js';

const HOSTNAME =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

const httpMockHostSchema = z
  .string()
  .regex(
    HOSTNAME,
    'HTTP mock keys must be lowercase hostnames, such as api.example.com, with no scheme, port, or path.',
  );

export const httpMockResponseSchema = z
  .object({
    status: z.number().int().min(100).max(599),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.string().optional(),
    json: z.unknown().optional(),
  })
  .strict()
  .refine(
    (response) => response.body === undefined || response.json === undefined,
    'Set body or json on an HTTP mock response, not both.',
  );

const httpMockHandlerSchema = z.custom<
  (request: HttpMockRequest) => HttpMockResponse | Promise<HttpMockResponse>
>((value) => typeof value === 'function', {
  message: 'HTTP mock handlers must be functions.',
});

const httpMockConfigSchema = z.union([
  z.object({response: httpMockResponseSchema}).strict(),
  z.object({handler: httpMockHandlerSchema}).strict(),
]);

export const httpMocksSchema = z.record(
  httpMockHostSchema,
  httpMockConfigSchema,
);
