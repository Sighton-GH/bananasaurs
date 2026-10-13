import { bootTheme } from './app/theme-boot.js';

bootTheme({ getItem: (key) => window.localStorage.getItem(key) }, document.documentElement);

import '@fontsource-variable/inter';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';
import './styles.css';

const root = document.getElementById('root');
if (root === null) throw new Error('#root is missing from index.html');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
