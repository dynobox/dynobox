import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {Login} from './Login';

const auth = vi.hoisted(() => ({
  resetPasswordForEmail: vi.fn(),
  signInWithPassword: vi.fn(),
  signUp: vi.fn(),
}));

vi.mock('./supabase', () => ({
  supabase: {auth},
}));

describe('Login', () => {
  afterEach(() => {
    cleanup();
    auth.resetPasswordForEmail.mockReset();
    auth.signInWithPassword.mockReset();
    auth.signUp.mockReset();
    window.history.pushState({}, '', '/login');
  });

  it('shows a reset-success message from the query string', () => {
    window.history.pushState({}, '', '/login?reset=success');

    render(<Login />);

    expect(
      screen.getByText('Password updated. Sign in with your new password.'),
    ).toBeTruthy();
  });

  it('hides the password toggle until a password is entered', () => {
    render(<Login />);

    const password = screen.getByLabelText('Password');
    expect(screen.queryByRole('button', {name: 'Show password'})).toBeNull();

    fireEvent.change(password, {target: {value: 'password123'}});

    expect(screen.getByRole('button', {name: 'Show password'})).toBeTruthy();
  });

  it('toggles password visibility', () => {
    render(<Login />);

    const password = screen.getByLabelText('Password') as HTMLInputElement;
    fireEvent.change(password, {target: {value: 'password123'}});
    fireEvent.click(screen.getByRole('button', {name: 'Show password'}));

    expect(password.type).toBe('text');
    expect(screen.getByRole('button', {name: 'Hide password'})).toBeTruthy();
  });

  it('submits account creation through Supabase', async () => {
    auth.signUp.mockResolvedValue({error: null});
    render(<Login />);

    fireEvent.click(screen.getByRole('button', {name: 'Create account'}));
    fireEvent.change(screen.getByLabelText('Email'), {
      target: {value: 'user@example.com'},
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: {value: 'password123'},
    });
    fireEvent.click(screen.getByRole('button', {name: 'Create account'}));

    await waitFor(() => {
      expect(auth.signUp).toHaveBeenCalledWith({
        email: 'user@example.com',
        password: 'password123',
        options: {emailRedirectTo: 'http://localhost:5173'},
      });
    });
  });
});
