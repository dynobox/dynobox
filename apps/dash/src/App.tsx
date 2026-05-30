import {useAuth} from './AuthContext';
import {CliAuth} from './CliAuth';
import {Dashboard} from './Dashboard';
import {Login} from './Login';
import {ResetPassword} from './ResetPassword';

export function App() {
  const {isAuthenticated, isLoading} = useAuth();
  const path = window.location.pathname;

  if (isLoading) {
    return <main className="page">Loading...</main>;
  }

  if (path === '/reset-password') {
    return <ResetPassword />;
  }

  if (!isAuthenticated) {
    return <Login />;
  }

  if (path === '/cli-auth') {
    return <CliAuth />;
  }

  return <Dashboard />;
}
