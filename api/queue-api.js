import express from 'express';
import cors from 'cors';
import * as Sentry from '@sentry/node';
import { queueService } from './queue-service.js';

const app = express();

app.use(cors({
  exposedHeaders: ['sentry-trace', 'baggage'],
  allowedHeaders: ['Content-Type', 'sentry-trace', 'baggage'],
}));
app.use(express.json());

app.use((req, res, next) => {
  const sentryTrace = req.headers['sentry-trace'];
  const baggage = req.headers['baggage'];
  
  if (sentryTrace) {
    Sentry.continueTrace(
      { 'sentry-trace': sentryTrace, baggage },
      () => {
        Sentry.startSpan(
          {
            op: 'http.server',
            name: `${req.method} ${req.path}`,
            attributes: {
              'http.method': req.method,
              'http.url': req.url,
            },
          },
          () => {
            next();
          }
        );
      }
    );
  } else {
    Sentry.startSpan(
      {
        op: 'http.server',
        name: `${req.method} ${req.path}`,
        attributes: {
          'http.method': req.method,
          'http.url': req.url,
        },
      },
      () => {
        next();
      }
    );
  }
});

app.post('/queue/receive', (req, res) => {
  const { queueName, maxMessages = 1 } = req.body;
  console.log(`[Queue API] Receiving messages from ${queueName}, maxMessages: ${maxMessages}`);
  const messages = queueService.getMessages(queueName, maxMessages);
  console.log(`[Queue API] Returning ${messages.length} message(s)`);
  if (messages.length > 0) {
    console.log(`[Queue API] Message details:`, {
      messageId: messages[0].MessageId,
      hasTrace: !!messages[0].sentryTrace,
      hasBaggage: !!messages[0].baggage,
      traceId: messages[0].sentryTrace?.split('-')[0],
    });
  }
  res.json({ messages });
});

app.post('/queue/send', (req, res) => {
  const { queueName, message } = req.body;
  console.log(`[Queue API] Sending message to ${queueName}:`, {
    messageId: message.MessageId || 'new',
    hasTrace: !!message.sentryTrace,
    hasBaggage: !!message.baggage,
    traceId: message.sentryTrace?.split('-')[0],
    sentryTrace: message.sentryTrace,
  });
  queueService.sendMessage(queueName, message);
  res.json({ success: true });
});

app.get('/queue/status', (req, res) => {
  try {
    const traceData = Sentry.getTraceData();
    let activeSpan = null;
    
    try {
      activeSpan = Sentry.getActiveSpan();
    } catch (e) {}
    
    let activeSpanJson = null;
    if (activeSpan) {
      try {
        activeSpanJson = Sentry.spanToJSON(activeSpan);
      } catch (e) {
        console.error('Error converting active span to JSON:', e);
      }
    }
    
    const taskQueue = queueService.getQueue('task-queue');
    const pythonWorkerQueue = queueService.getQueue('python-worker-queue');
    
    res.json({
      traceData: {
        traceId: traceData?.traceId,
        spanId: traceData?.spanId,
        parentSpanId: traceData?.parentSpanId,
      },
      activeSpan: activeSpanJson ? {
        traceId: activeSpanJson.trace_id,
        spanId: activeSpanJson.span_id,
        parentSpanId: activeSpanJson.parent_span_id,
        op: activeSpanJson.op,
      } : null,
      queues: {
        'task-queue': {
          size: taskQueue.length,
          messages: taskQueue.map(msg => ({
            messageId: msg.MessageId,
            hasTrace: !!msg.sentryTrace,
            traceId: msg.sentryTrace?.split('-')[0],
            traceMetadata: msg._traceMetadata,
          })),
        },
        'python-worker-queue': {
          size: pythonWorkerQueue.length,
          messages: pythonWorkerQueue.map(msg => ({
            messageId: msg.MessageId,
            hasTrace: !!msg.sentryTrace,
            traceId: msg.sentryTrace?.split('-')[0],
            traceMetadata: msg._traceMetadata,
          })),
        },
      },
    });
  } catch (error) {
    console.error('Error in /queue/status:', error);
    res.status(500).json({
      error: 'Failed to get queue status',
      message: error.message,
    });
  }
});

Sentry.setupExpressErrorHandler(app);

const PORT = process.env.QUEUE_API_PORT || 3002;
app.listen(PORT, () => {
  console.log(`Queue API server running on http://localhost:${PORT}`);
});

