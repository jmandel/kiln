import React from 'react';
import { createRoot } from 'react-dom/client';
import DocGenApp from './components/DocGenApp';
import './index.css';
import './documentTypes/narrative';
import './documentTypes/fhir';

const root = createRoot(document.getElementById('root') as HTMLElement);
root.render(<DocGenApp />);
