import type {ApiBindings} from './types.js';

export type TokenRow = {
  provider: string;
  subject_id: string;
  token_hash: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

export function createTestEnv(rows: TokenRow[] = []): ApiBindings {
  return {
    BROWSER_AUTH_SECRET: 'browser-secret',
    DB: createD1Mock(rows),
    SUPABASE_ANON_KEY: 'supabase-anon-key',
    SUPABASE_URL: 'https://supabase.example.test',
    TOKEN_PEPPER: 'test-pepper',
  };
}

function createD1Mock(rows: TokenRow[]): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            first<T>() {
              const tokenHash = String(values[0]);
              const row = rows.find(
                (candidate) =>
                  candidate.token_hash === tokenHash &&
                  candidate.revoked_at === null,
              );

              return Promise.resolve(
                row === undefined
                  ? null
                  : ({
                      provider: row.provider,
                      subject_id: row.subject_id,
                    } as T),
              );
            },
            run() {
              if (sql.includes('INSERT INTO api_tokens')) {
                rows.push({
                  last_used_at: null,
                  provider: String(values[2]),
                  revoked_at: null,
                  subject_id: String(values[1]),
                  token_hash: String(values[3]),
                });
              }

              if (sql.includes('UPDATE api_tokens')) {
                const tokenHash = String(values[1]);
                const row = rows.find(
                  (candidate) => candidate.token_hash === tokenHash,
                );
                if (row !== undefined) {
                  row.last_used_at = String(values[0]);
                }
              }

              return Promise.resolve({success: true} as D1Result);
            },
          };
        },
      };
    },
  } as D1Database;
}
