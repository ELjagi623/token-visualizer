import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './design/fonts.ts';
import './design/tokens.css';
import './design/base.css';
import { App } from './App.tsx';

const el = document.getElementById('root');
if (el) {
  createRoot(el).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
