import {type SyntheticEvent, useState} from 'react';

import {PasswordField} from './PasswordField';
import {supabase} from './supabase';

type AuthMode = 'sign-in' | 'sign-up' | 'reset-password';

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<AuthMode>('sign-in');
  const [message, setMessage] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('reset') === 'success'
      ? 'Password updated. Sign in with your new password.'
      : null;
  });
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const isPasswordMode = mode !== 'reset-password';

  async function handleSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    setIsLoading(true);

    const result = await submitAuthForm(mode, email, password);

    setIsLoading(false);

    if (result.error !== null) {
      setError(result.error.message);
      return;
    }

    if (mode === 'reset-password') {
      setMessage('Check your email for a password reset link.');
    }

    if (mode === 'sign-up') {
      setMessage('Check your email to confirm your account.');
    }
  }

  return (
    <main className="auth-page">
      <form className="auth-card" onSubmit={handleSubmit}>
        <h1>{getTitle(mode)}</h1>
        <label className="auth-field">
          <span>Email</span>
          <input
            autoComplete="email"
            onChange={(event) => setEmail(event.target.value)}
            required
            type="email"
            value={email}
          />
        </label>
        {isPasswordMode && (
          <PasswordField
            autoComplete={
              mode === 'sign-up' ? 'new-password' : 'current-password'
            }
            label="Password"
            onChange={setPassword}
            value={password}
          />
        )}
        <button className="auth-submit" disabled={isLoading} type="submit">
          {isLoading ? 'Working...' : getSubmitLabel(mode)}
        </button>
        <div className="auth-links">
          {mode !== 'sign-in' && (
            <button
              className="link-button"
              onClick={() => setAuthMode('sign-in')}
              type="button"
            >
              Sign in
            </button>
          )}
          {mode !== 'sign-up' && (
            <button
              className="link-button"
              onClick={() => setAuthMode('sign-up')}
              type="button"
            >
              Create account
            </button>
          )}
          {mode !== 'reset-password' && (
            <button
              className="link-button"
              onClick={() => setAuthMode('reset-password')}
              type="button"
            >
              Forgot password?
            </button>
          )}
        </div>
        {message !== null && <p className="message">{message}</p>}
        {error !== null && <p className="error">{error}</p>}
      </form>
    </main>
  );

  function setAuthMode(nextMode: AuthMode) {
    setError(null);
    setMessage(null);
    setMode(nextMode);
  }
}

function getTitle(mode: AuthMode): string {
  if (mode === 'sign-up') {
    return 'Create account';
  }

  if (mode === 'reset-password') {
    return 'Reset password';
  }

  return 'Sign in';
}

function getSubmitLabel(mode: AuthMode): string {
  if (mode === 'sign-up') {
    return 'Create account';
  }

  if (mode === 'reset-password') {
    return 'Send reset link';
  }

  return 'Sign in';
}

async function submitAuthForm(mode: AuthMode, email: string, password: string) {
  const redirectOrigin =
    import.meta.env.VITE_AUTH_REDIRECT_ORIGIN ?? window.location.origin;

  if (mode === 'sign-up') {
    return supabase.auth.signUp({
      email,
      password,
      options: {emailRedirectTo: redirectOrigin},
    });
  }

  if (mode === 'reset-password') {
    return supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${redirectOrigin}/reset-password`,
    });
  }

  return supabase.auth.signInWithPassword({email, password});
}
