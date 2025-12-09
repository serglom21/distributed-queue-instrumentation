// Sentry initialization file - must be imported before Express app is created
// This file is imported via --import flag when running Node.js
import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';
import dotenv from 'dotenv';

// Load .env file BEFORE Sentry initialization
dotenv.config();

console.log('[Sentry Init] DSN loaded:', process.env.SENTRY_DSN ? 'YES' : 'NO');

// Initialize Sentry v10
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  integrations: [
    // In v10, expressIntegration with router:true automatically instruments Express
    Sentry.expressIntegration({
      // Enable router instrumentation to create spans for routes
      router: true,
    }),
    // Http integration - instruments outgoing HTTP requests
    Sentry.httpIntegration({
      // Propagate trace context on outgoing requests
      tracing: true,
    }),
    nodeProfilingIntegration(),
  ],
  tracesSampleRate: 1.0, // 100% sampling for testing
  profilesSampleRate: 1.0,
  environment: 'development',
  // Enable to see what Sentry is doing
  debug: true,
});


