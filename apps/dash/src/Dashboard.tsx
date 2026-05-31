import {useAuth} from './AuthContext';

export function Dashboard() {
  const {session} = useAuth();

  return (
    <main className="page">
      <section className="card">
        <h1>Dashboard</h1>
        <p>Signed in as {session?.user.email}</p>
        <p>Run history will land here in the next story.</p>
      </section>
    </main>
  );
}
