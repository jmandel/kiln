import React from 'react';
import { createRoot } from 'react-dom/client';
import DocGenApp from './components/DocGenApp';
import './index.css';
import './documentTypes/narrative';
import './documentTypes/fhir';
import faviconUrl from '../public/favicon-32x32.png';

// Set favicon dynamically
const link = document.querySelector("link[rel~='icon']") as HTMLLinkElement || document.createElement('link');
link.type = 'image/png';
link.rel = 'icon';
link.href = faviconUrl;
if (!document.querySelector("link[rel~='icon']")) {
  document.getElementsByTagName('head')[0].appendChild(link);
}

const root = createRoot(document.getElementById('root') as HTMLElement);
root.render(<DocGenApp />);
