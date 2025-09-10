import React from 'react';
import { createRoot } from 'react-dom/client';
import DocGenApp from './components/DocGenApp';

const root = createRoot(document.getElementById('root') as HTMLElement);
root.render(<DocGenApp />);
