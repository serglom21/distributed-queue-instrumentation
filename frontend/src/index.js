import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import * as Sentry from '@sentry/react';

// Initialize Sentry (only if DSN is provided)
if (process.env.REACT_APP_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.REACT_APP_SENTRY_DSN,
    integrations: [
      Sentry.browserTracingIntegration(),
    ],
    tracesSampleRate: 1.0, // 100% for testing
    environment: 'development',
    tracePropagationTargets: [
        'localhost',                    // String match for localhost
        'http://localhost:3001',        // Exact match for API server
        /^https?:\/\/localhost/,        // Regex for any localhost URL
        /^https?:\/\/localhost:\d+/,    // Regex for localhost with port
        /^https?:\/\/127\.0\.0\.1/,    // Regex for IP address
        /^\//,                          // Relative paths
      ],
    beforeSend(event, hint) {
      // Log events for debugging
      console.log('Sentry event:', event);
      return event;
    },
  });
  
  // Make Sentry available globally for debugging
  window.Sentry = Sentry;
  console.log('[Frontend] Sentry initialized with trace propagation targets');
  console.log('[Frontend] REACT_APP_SENTRY_DSN:', process.env.REACT_APP_SENTRY_DSN ? 'Set' : 'NOT SET');
} else {
  console.warn('Warning: REACT_APP_SENTRY_DSN not set. Sentry tracing disabled.');
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

