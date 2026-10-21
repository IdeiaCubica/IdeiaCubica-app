import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './ui/theme.css';
import { AuthGate } from './ui/Auth';
import { StoreProvider } from './ui/store';
import { App } from './ui/App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate>
      <StoreProvider>
        <App />
      </StoreProvider>
    </AuthGate>
  </StrictMode>,
);
