import {useEffect} from 'react';

import {AppShell} from './AppShell';
import {useAuth} from './AuthContext';
import {CliAuth} from './CliAuth';
import {Dashboard} from './Dashboard';
import {Login} from './Login';
import {replaceLocation} from './navigation';
import {ResetPassword} from './ResetPassword';

export function App() {
  const {isAuthenticated, isLoading} = useAuth();
  const path = window.location.pathname;

  if (isLoading) {
    return null;
  }

  if (path === '/reset-password') {
    return (
      <AppShell>
        <ResetPassword />
      </AppShell>
    );
  }

  if (!isAuthenticated) {
    if (path !== '/login') {
      return <Redirect to="/login" />;
    }

    return (
      <AppShell>
        <Login />
      </AppShell>
    );
  }

  if (path === '/login') {
    return <Redirect to="/" />;
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

function Redirect({to}: {to: string}) {
  useEffect(() => {
    replaceLocation(to);
  }, [to]);

  return null;
}
