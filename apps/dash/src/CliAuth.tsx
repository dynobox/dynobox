import {useState} from 'react';

import {useAuth} from './AuthContext';

export function CliAuth() {
  const {getAccessToken} = useAuth();
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  async function createToken() {
    setError(null);
    setToken(null);
    setIsLoading(true);

    const accessToken = await getAccessToken();
    if (accessToken === null) {
      setIsLoading(false);
      setError('Sign in again before creating a CLI token.');
      return;
    }

    const response = await fetch(`${import.meta.env.API_BASE_URL}/cli-tokens`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
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
      <section className="card">
        <h1>CLI auth</h1>
        <p>Create a token, then paste it into `dynobox login`.</p>
        <button
          disabled={isLoading}
          onClick={() => void createToken()}
          type="button"
        >
          {isLoading ? 'Creating...' : 'Create CLI token'}
        </button>
        {token !== null && <code className="token">{token}</code>}
        {error !== null && <p className="error">{error}</p>}
      </section>
    </main>
  );
}
