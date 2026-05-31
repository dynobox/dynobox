import {cleanup, render, screen} from '@testing-library/react';
import type {ReactNode} from 'react';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {App} from './App';

const authState = vi.hoisted(() => ({
  value: {
    getAccessToken: async () => null,
    isAuthenticated: false,
    isLoading: false,
    session: null,
    signOut: async () => {},
  },
}));

const replaceLocation = vi.hoisted(() => vi.fn());

vi.mock('./AuthContext', () => ({
  useAuth: () => authState.value,
}));

vi.mock('./AppShell', () => ({
  AppShell: ({children}: {children: ReactNode}) => <div>{children}</div>,
}));

vi.mock('./CliAuth', () => ({
  CliAuth: () => <div>CLI auth page</div>,
}));

vi.mock('./Dashboard', () => ({
  Dashboard: () => <div>Dashboard page</div>,
}));

vi.mock('./Login', () => ({
  Login: () => <div>Login page</div>,
}));

vi.mock('./navigation', () => ({
  replaceLocation,
}));

vi.mock('./ResetPassword', () => ({
  ResetPassword: () => <div>Reset password page</div>,
}));

describe('App', () => {
  afterEach(() => {
    cleanup();
    authState.value = {
      getAccessToken: async () => null,
      isAuthenticated: false,
      isLoading: false,
      session: null,
      signOut: async () => {},
    };
    vi.restoreAllMocks();
    replaceLocation.mockReset();
    window.history.pushState({}, '', '/');
  });

  it('renders the login page at /login when signed out', () => {
    window.history.pushState({}, '', '/login');

    render(<App />);

    expect(screen.getByText('Login page')).toBeTruthy();
  });

  it('redirects signed-out protected routes to /login', () => {
    window.history.pushState({}, '', '/cli-auth');

    render(<App />);

    expect(replaceLocation).toHaveBeenCalledWith('/login');
  });

  it('redirects authenticated /login visits to the dashboard route', () => {
    authState.value = {
      ...authState.value,
      isAuthenticated: true,
    };
    window.history.pushState({}, '', '/login');

    render(<App />);

    expect(replaceLocation).toHaveBeenCalledWith('/');
  });

  it('renders /cli-auth for authenticated users', () => {
    authState.value = {
      ...authState.value,
      isAuthenticated: true,
    };
    window.history.pushState({}, '', '/cli-auth');

    render(<App />);

    expect(screen.getByText('CLI auth page')).toBeTruthy();
  });
});
