import React from 'react';
import { createRoot } from 'react-dom/client';
import DocGenApp from './components/DocGenApp';
import './index.css';
import './documentTypes/narrative';
import './documentTypes/fhir';
import { config, ConfigProvider } from './config';
import faviconUrl from '../public/favicon-32x32.png';

// Set favicon dynamically
const link = document.querySelector("link[rel~='icon']") as HTMLLinkElement || document.createElement('link');
link.type = 'image/png';
link.rel = 'icon';
link.href = faviconUrl;
if (!document.querySelector("link[rel~='icon']")) {
  document.getElementsByTagName('head')[0].appendChild(link);
}

async function bootstrap() {
  try {
    await config.init();
    const root = createRoot(document.getElementById('root') as HTMLElement);
    root.render(
      <React.StrictMode>
        <ConfigProvider>
          <DocGenApp />
        </ConfigProvider>
      </React.StrictMode>
    );
  } catch (e) {
    const root = createRoot(document.getElementById('root') as HTMLElement);
    root.render(
      <div style={{ padding: '2rem', fontFamily: 'system-ui' }}>
        <h1>Kiln Startup Error</h1>
        <p>Failed to initialize configuration.</p>
        <pre style={{ whiteSpace: 'pre-wrap' }}>{String(e)}</pre>
        <button onClick={() => window.location.reload()}>Retry</button>
      </div>
    );
  }
}

bootstrap();
