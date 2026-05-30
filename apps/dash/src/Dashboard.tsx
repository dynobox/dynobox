import {useAuth} from './AuthContext';

export function Dashboard() {
  const {session, signOut} = useAuth();

  return (
    <main className="page">
      <header className="topbar">
        <strong>dynobox</strong>
        <nav>
          <a href="/">Dashboard</a>
          <a href="/cli-auth">CLI auth</a>
          <button onClick={() => void signOut()} type="button">
            Sign out
          </button>
        </nav>
      </header>
      <section className="card">
        <h1>Dashboard</h1>
        <p>Signed in as {session?.user.email}</p>
        <p>Run history will land here in the next story.</p>
      </section>
    </main>
  );
}
