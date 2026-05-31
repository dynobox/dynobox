import type {ReactNode} from 'react';

import {useAuth} from './AuthContext';

type AppShellProps = {
  children: ReactNode;
};

export function AppShell({children}: AppShellProps) {
  const {isAuthenticated, signOut} = useAuth();

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <a
            className="brand"
            href="https://dynobox.xyz"
            aria-label="Dynobox home"
          >
            <span className="brand-mark">dynobox</span>
            <span className="brand-section">dash</span>
          </a>
          <div className="topbar-content">
            <div className="top-actions">
              <nav className="topnav" aria-label="Primary navigation">
                {isAuthenticated && <a href="/">Dashboard</a>}
                {isAuthenticated && <a href="/cli-auth">CLI auth</a>}
                {isAuthenticated && (
                  <button
                    className="topnav-button"
                    onClick={() => void signOut()}
                    type="button"
                  >
                    Sign out
                  </button>
                )}
              </nav>
            </div>
          </div>
        </div>
      </header>
      {children}
      <footer className="footer">
        <div className="footer-inner">
          <div className="footer-links">
            <a href="https://x.com/dynobox_xyz" target="_blank">
              @dynobox_xyz
            </a>
            <a href="mailto:dynobox@bhk.dev">dynobox@bhk.dev</a>
          </div>
          <div className="footer-links footer-links-right">
            <a href="https://docs.dynobox.xyz">Docs</a>
            <a href="https://github.com/dynobox/dynobox" target="_blank">
              GitHub
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
