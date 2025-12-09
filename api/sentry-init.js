import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';
import dotenv from 'dotenv';

dotenv.config();

console.log('[Sentry Init] DSN loaded:', process.env.SENTRY_DSN ? 'YES' : 'NO');

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  integrations: [
    Sentry.expressIntegration({ router: true }),
    Sentry.httpIntegration({ tracing: true }),
    nodeProfilingIntegration(),
  ],
  tracesSampleRate: 1.0,
  profilesSampleRate: 1.0,
  environment: 'development',
  debug: true,
});


