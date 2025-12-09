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
          () => next()
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
      () => next()
    );
  }
});

async function scheduleTask(taskData) {
  const currentTraceData = Sentry.getTraceData();
  let activeSpan = null;
  
  try {
    activeSpan = Sentry.getActiveSpan();
  } catch (e) {
    // No active span
  }
  
  return Sentry.startSpan(
    {
      name: 'queue.send',
      op: 'queue.send',
      attributes: {
        'queue.name': 'task-queue',
        'task.type': taskData.taskType,
      },
    },
    async (queueSpan) => {
      const queueSpanTraceHeader = Sentry.spanToTraceHeader(queueSpan);
      const queueSpanJson = Sentry.spanToJSON(queueSpan);
      const queueTraceData = Sentry.getTraceData();
      
      const message = {
        ...taskData,
        sentryTrace: queueSpanTraceHeader,
        baggage: queueTraceData?.baggage,
        _traceMetadata: {
          traceId: queueSpanJson?.trace_id,
          spanId: queueSpanJson?.span_id,
          parentSpanId: queueSpanJson?.parent_span_id,
        },
      };

      const queueApiUrl = process.env.QUEUE_API_URL || 'http://localhost:3002';
      const fetchHeaders = { 
        'Content-Type': 'application/json',
        'sentry-trace': queueSpanTraceHeader,
      };
      
      if (queueTraceData?.baggage) {
        fetchHeaders['baggage'] = queueTraceData.baggage;
      }
      
      try {
        const response = await fetch(`${queueApiUrl}/queue/send`, {
          method: 'POST',
          headers: fetchHeaders,
          body: JSON.stringify({ queueName: 'task-queue', message }),
        });
    
        if (!response.ok) {
          console.error('[API] Failed to send message to queue API:', response.statusText);
          queueService.sendMessage('task-queue', message);
        }
      } catch (error) {
        console.error('[API] Error sending message to queue API:', error.message);
        queueService.sendMessage('task-queue', message);
      }
      
      return { 
        messageId: `msg-${Date.now()}`, 
        queued: true,
        traceMetadata: message._traceMetadata,
      };
    }
  );
}

app.post('/api/tasks', async (req, res) => {
  try {
    const { taskType, userId } = req.body;

    const shouldBlock = Math.random() < 0.1;
    if (shouldBlock) {
      return res.status(403).json({ error: 'Task blocked' });
    }

    const result = await scheduleTask({
      taskType,
      userId,
      timestamp: new Date().toISOString(),
    });

    res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error('Error in /api/tasks:', error);
    Sentry.captureException(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/trace-info', (req, res) => {
  try {
    const traceData = Sentry.getTraceData();
    let activeSpan = null;
    let rootSpan = null;
    
    try {
      activeSpan = Sentry.getActiveSpan();
    } catch (e) {}
    
    try {
      rootSpan = Sentry.getRootSpan();
    } catch (e) {}
    
    let activeSpanJson = null;
    let rootSpanJson = null;
    
    if (activeSpan) {
      try {
        activeSpanJson = Sentry.spanToJSON(activeSpan);
      } catch (e) {
        console.error('Error converting active span to JSON:', e);
      }
    }
    
    if (rootSpan) {
      try {
        rootSpanJson = Sentry.spanToJSON(rootSpan);
      } catch (e) {
        console.error('Error converting root span to JSON:', e);
      }
    }
    
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
        description: activeSpanJson.description,
      } : null,
      rootSpan: rootSpanJson ? {
        traceId: rootSpanJson.trace_id,
        spanId: rootSpanJson.span_id,
        parentSpanId: rootSpanJson.parent_span_id,
        op: rootSpanJson.op,
        description: rootSpanJson.description,
      } : null,
      incomingHeaders: {
        'sentry-trace': req.headers['sentry-trace'] || null,
        'baggage': req.headers['baggage'] || null,
      },
    });
  } catch (error) {
    console.error('Error in /api/trace-info:', error);
    res.status(500).json({ 
      error: 'Failed to get trace info',
      message: error.message,
    });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`API server running on http://localhost:${PORT}`);
});
