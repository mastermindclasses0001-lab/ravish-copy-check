import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App.tsx';
import './index.css';

declare global {
  interface Window {
    __safalDeferredPrompt?: Event | null;
    __safalPwaInstalled?: boolean;
  }
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  window.__safalDeferredPrompt = e;
});

window.addEventListener('appinstalled', () => {
  window.__safalDeferredPrompt = null;
  window.__safalPwaInstalled = true;
});

registerSW({ immediate: true });

createRoot(document.getElementById('root')!).render(<App />);
