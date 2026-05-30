import {useState} from 'react';

import {useAuth} from './AuthContext';

export function CliAuth() {
  const {session, signOut} = useAuth();
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  async function createToken() {
    setError(null);
    setToken(null);
    setIsLoading(true);

    const response = await fetch(`${import.meta.env.API_BASE_URL}/cli-tokens`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session?.access_token ?? ''}`,
      },
    });

    setIsLoading(false);

    if (!response.ok) {
      setError('Could not create a CLI token.');
      return;
    }

    const data = (await response.json()) as {token: string};
    setToken(data.token);
  }

  return (
    <main className="page">
      <header className="topbar">
        <strong>dynobox</strong>
        <nav>
          <a href="/">Dashboard</a>
          <a href="/cli-auth">CLI auth</a>
          <button onClick={() => void signOut()} type="button">
            Sign out
          </button>
        </nav>
      </header>
      <section className="card">
        <h1>CLI auth</h1>
        <p>Create a token, then paste it into `dynobox login`.</p>
        <button disabled={isLoading} onClick={() => void createToken()} type="button">
          {isLoading ? 'Creating...' : 'Create CLI token'}
        </button>
        {token !== null && <code className="token">{token}</code>}
        {error !== null && <p className="error">{error}</p>}
      </section>
    </main>
  );
}
