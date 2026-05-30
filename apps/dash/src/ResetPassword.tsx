import {useState, type FormEvent} from 'react';

import {supabase} from './supabase';

export function ResetPassword() {
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    setIsLoading(true);

    const {error} = await supabase.auth.updateUser({password});
    setIsLoading(false);

    if (error !== null) {
      setError(error.message);
      return;
    }

    setMessage('Password updated. You can return to the dashboard.');
  }

  return (
    <main className="auth-page">
      <form className="card" onSubmit={handleSubmit}>
        <h1>Set a new password</h1>
        <label>
          New password
          <input
            autoComplete="new-password"
            minLength={8}
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
        </label>
        <button disabled={isLoading} type="submit">
          {isLoading ? 'Saving...' : 'Update password'}
        </button>
        {message !== null && <p className="message">{message}</p>}
        {error !== null && <p className="error">{error}</p>}
      </form>
    </main>
  );
}
