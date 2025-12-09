import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';
import dotenv from 'dotenv';

// Load .env file
dotenv.config();

console.log('[Node Worker] DSN loaded:', process.env.SENTRY_DSN ? 'YES' : 'NO');

// Initialize Sentry v8 (using official queue pattern with continueTrace)
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  integrations: [
    nodeProfilingIntegration(),
  ],
  tracesSampleRate: 1.0,
  profilesSampleRate: 1.0,
  environment: 'development',
});

// Process messages from queue
async function processMessage(message) {
  console.log('[Node Worker] Processing message:', {
    messageId: message.MessageId,
    sentryTrace: message.sentryTrace,
    hasTrace: !!message.sentryTrace,
  });

  if (!message.sentryTrace) {
    console.warn('[Node Worker] WARNING: No sentryTrace in message!');
    return { success: false, error: 'No trace context' };
  }

  // OFFICIAL SENTRY PATTERN for queue consumers (from docs)
  // Use continueTrace with nested spans: outer parent + inner queue.process
  return Sentry.continueTrace(
    { 
      sentryTrace: message.sentryTrace, 
      baggage: message.baggage 
    },
    () => {
      // Outer parent span (transaction)
      return Sentry.startSpan(
        {
          name: 'node-worker-transaction',
          op: 'function',
        },
        async (parentSpan) => {
          // Inner queue.process span
          return await Sentry.startSpan(
            {
              name: 'node-worker.process',
              op: 'queue.process',
              attributes: {
                'messaging.message.id': message.MessageId,
                'messaging.destination.name': 'task-queue',
                'messaging.message.body.size': JSON.stringify(message).length,
                'task.type': message.taskType,
              },
            },
            async (span) => {
              console.log('[Node Worker] Processing task:', message.taskType);
              
              // Get span info to verify trace continuation
              const spanJson = Sentry.spanToJSON(span);
              console.log('[Node Worker] Span info:', {
                traceId: spanJson?.trace_id,
                spanId: spanJson?.span_id,
                parentSpanId: spanJson?.parent_span_id,
              });
              
              // Simulate work
              await new Promise(resolve => setTimeout(resolve, 100));
              
              // Send to Python worker queue with trace propagation
              const traceHeader = Sentry.spanToTraceHeader(span);
              const baggageHeader = Sentry.spanToBaggageHeader(span);
              
              console.log('[Node Worker] Sending to Python worker');
              
              await fetch('http://localhost:3002/queue/send', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'sentry-trace': traceHeader,
                  'baggage': baggageHeader || '',
                },
                body: JSON.stringify({
                  queueName: 'python-worker-queue',
                  message: {
                    ...message,
                    sentryTrace: traceHeader,
                    baggage: baggageHeader,
                  },
                }),
              });
              
              // Mark as successful
              parentSpan.setStatus({ code: 1, message: 'ok' });
              
              await Sentry.flush(2000);
              
              return { success: true, processedBy: 'node-worker' };
            }
          );
        }
      );
    }
  );
}

// Poll for messages
async function pollQueue() {
  while (true) {
    try {
      const response = await fetch('http://localhost:3002/queue/receive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          queueName: 'task-queue',
          maxMessages: 1,
        }),
      });
      
      const data = await response.json();
      
      if (data.messages && data.messages.length > 0) {
        for (const message of data.messages) {
          try {
            await processMessage(message);
          } catch (error) {
            console.error('[Node Worker] Error processing message:', error);
            Sentry.captureException(error);
          }
        }
      }
      
      // Wait before polling again
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      console.error('[Node Worker] Error polling queue:', error);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

console.log('[Node Worker] Starting worker...');
pollQueue();
