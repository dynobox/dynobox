/** Runtime bindings configured on the Cloudflare Worker. */
export type ApiBindings = {
  DB: D1Database;
  BROWSER_AUTH_SECRET: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  SUPABASE_URL: string;
  TOKEN_PEPPER: string;
};

/** Provider-neutral user identity stored with API-owned data. */
export type Identity = {
  provider: string;
  subjectId: string;
};
