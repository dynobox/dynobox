import './styles.css';

import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';

import {App} from './App';
import {AuthProvider} from './AuthContext';

const root = document.getElementById('root');

if (root === null) {
  throw new Error('Missing root element.');
}

createRoot(root).render(
  <StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </StrictMode>,
);
