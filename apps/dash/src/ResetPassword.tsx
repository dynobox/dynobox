import {type SyntheticEvent, useState} from 'react';

import {PasswordField} from './PasswordField';
import {supabase} from './supabase';

export function ResetPassword() {
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit(event: SyntheticEvent<HTMLFormElement>) {
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

    setMessage('Password updated. Redirecting to sign in.');
    await supabase.auth.signOut();
    window.location.assign('/?reset=success');
  }

  return (
    <main className="auth-page">
      <form className="auth-card" onSubmit={handleSubmit}>
        <h1>Set a new password</h1>
        <PasswordField
          autoComplete="new-password"
          label="New password"
          onChange={setPassword}
          value={password}
        />
        <button className="auth-submit" disabled={isLoading} type="submit">
          {isLoading ? 'Saving...' : 'Update password'}
        </button>
        {message !== null && <p className="message">{message}</p>}
        {error !== null && <p className="error">{error}</p>}
      </form>
    </main>
  );
}
