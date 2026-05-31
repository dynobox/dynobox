import {AppShell} from './AppShell';
import {useAuth} from './AuthContext';
import {CliAuth} from './CliAuth';
import {Dashboard} from './Dashboard';
import {Login} from './Login';
import {ResetPassword} from './ResetPassword';

export function App() {
  const {isAuthenticated, isLoading} = useAuth();
  const path = window.location.pathname;

  if (isLoading) {
    return (
      <AppShell>
        <main className="page">Loading...</main>
      </AppShell>
    );
  }

  if (path === '/reset-password') {
    return (
      <AppShell>
        <ResetPassword />
      </AppShell>
    );
  }

  if (!isAuthenticated) {
    return (
      <AppShell>
        <Login />
      </AppShell>
    );
  }

  if (path === '/cli-auth') {
    return (
      <AppShell>
        <CliAuth />
      </AppShell>
    );
  }

  return (
    <AppShell>
      <Dashboard />
    </AppShell>
  );
}
