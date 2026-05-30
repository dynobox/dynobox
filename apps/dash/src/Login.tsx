import {useState, type FormEvent} from 'react';

import {supabase} from './supabase';

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isResetMode, setIsResetMode] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    setIsLoading(true);

    const result = isResetMode
      ? await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/reset-password`,
        })
      : await supabase.auth.signInWithPassword({email, password});

    setIsLoading(false);

    if (result.error !== null) {
      setError(result.error.message);
      return;
    }

    if (isResetMode) {
      setMessage('Check your email for a password reset link.');
    }
  }

  return (
    <main className="auth-page">
      <form className="card" onSubmit={handleSubmit}>
        <h1>{isResetMode ? 'Reset password' : 'Sign in to Dynobox'}</h1>
        <label>
          Email
          <input
            autoComplete="email"
            onChange={(event) => setEmail(event.target.value)}
            required
            type="email"
            value={email}
          />
        </label>
        {!isResetMode && (
          <label>
            Password
            <input
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
              required
              type="password"
              value={password}
            />
          </label>
        )}
        <button disabled={isLoading} type="submit">
          {isLoading ? 'Working...' : isResetMode ? 'Send reset link' : 'Sign in'}
        </button>
        <button
          className="link-button"
          onClick={() => {
            setError(null);
            setMessage(null);
            setIsResetMode((value) => !value);
          }}
          type="button"
        >
          {isResetMode ? 'Back to sign in' : 'Forgot password?'}
        </button>
        {message !== null && <p className="message">{message}</p>}
        {error !== null && <p className="error">{error}</p>}
      </form>
    </main>
  );
}
