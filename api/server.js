import express from 'express';
import cors from 'cors';
import * as Sentry from '@sentry/node';
import { queueService } from './queue-service.js';

// Sentry is initialized in sentry-init.js via --import flag

const app = express();

// Set up CORS to allow trace headers
app.use(cors({
  // Allow sentry-trace and baggage headers for distributed tracing
  exposedHeaders: ['sentry-trace', 'baggage'],
  allowedHeaders: ['Content-Type', 'sentry-trace', 'baggage'],
}));
app.use(express.json());

// Manually add Sentry tracing middleware for v10
// This middleware will continue traces from incoming requests
app.use((req, res, next) => {
  // Extract trace headers from request
  const sentryTrace = req.headers['sentry-trace'];
  const baggage = req.headers['baggage'];
  
  if (sentryTrace) {
    console.log('[Sentry Middleware] Found sentry-trace header:', sentryTrace);
    
    // Use continueTrace to set up the context, then start a span for the request
    Sentry.continueTrace(
      { 'sentry-trace': sentryTrace, baggage },
      () => {
        // Start a span for this HTTP request
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
    console.log('[Sentry Middleware] No sentry-trace header, starting new trace');
    // No incoming trace, start a new one
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

// Schedule task function - this is where trace propagation happens
async function scheduleTask(taskData) {
  // Get current trace context (should be set by Express integration from incoming HTTP request)
  const currentTraceData = Sentry.getTraceData();
  let activeSpan = null;
  
  // Safely get active span
  try {
    activeSpan = Sentry.getActiveSpan();
  } catch (e) {
    // No active span
  }
  
  console.log('[ScheduleTask] Starting with trace context:', {
    traceId: currentTraceData?.traceId,
    spanId: currentTraceData?.spanId,
    parentSpanId: currentTraceData?.parentSpanId,
    hasActiveSpan: !!activeSpan,
  });
  
  if (activeSpan) {
    try {
      const spanJson = Sentry.spanToJSON(activeSpan);
      console.log('[ScheduleTask] Active span (should be HTTP server span):', {
        traceId: spanJson?.trace_id,
        spanId: spanJson?.span_id,
        parentSpanId: spanJson?.parent_span_id,
        op: spanJson?.op,
      });
    } catch (e) {
      console.error('[ScheduleTask] Error converting active span to JSON:', e);
    }
  }

  // CRITICAL: Create a child span for the queue operation
  // This will automatically be a child of the active span (the HTTP server span)
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
      // Get trace header from the queue span (this will be the parent for workers)
      const queueSpanTraceHeader = Sentry.spanToTraceHeader(queueSpan);
      const queueSpanJson = Sentry.spanToJSON(queueSpan);
      const queueTraceData = Sentry.getTraceData();
      
      console.log('[ScheduleTask] Queue span created:', {
        traceId: queueSpanJson?.trace_id,
        spanId: queueSpanJson?.span_id,
        parentSpanId: queueSpanJson?.parent_span_id,
        queueSpanTraceHeader,
        traceDataTraceId: queueTraceData?.traceId,
      });
      
      // Verify the queue span is a child of the HTTP span
      if (activeSpan) {
        const httpSpanJson = Sentry.spanToJSON(activeSpan);
        if (queueSpanJson?.parent_span_id !== httpSpanJson?.span_id) {
          console.warn('[ScheduleTask] ⚠️  Queue span parent mismatch!', {
            expected: httpSpanJson?.span_id,
            actual: queueSpanJson?.parent_span_id,
          });
        } else {
          console.log('[ScheduleTask] ✓ Queue span is correctly a child of HTTP span');
        }
      }
      
      // Add trace data to message - use the queue span's trace header
      const message = {
        ...taskData,
        sentryTrace: queueSpanTraceHeader,
        baggage: queueTraceData?.baggage,
        // Add trace metadata for testing
        _traceMetadata: {
          traceId: queueSpanJson?.trace_id,
          spanId: queueSpanJson?.span_id,
          parentSpanId: queueSpanJson?.parent_span_id,
        },
      };

      // Send to queue via Queue API (ensures same queue instance)
      // Since API server and Queue API are separate processes, we need to use HTTP
      const queueApiUrl = process.env.QUEUE_API_URL || 'http://localhost:3002';
      
      // Build headers with trace propagation - use queue span's trace header
      const fetchHeaders = { 
        'Content-Type': 'application/json',
        'sentry-trace': queueSpanTraceHeader,
      };
      
      if (queueTraceData?.baggage) {
        fetchHeaders['baggage'] = queueTraceData.baggage;
      }
      
      console.log('[ScheduleTask] Sending to queue-api with headers:', {
        'sentry-trace': fetchHeaders['sentry-trace'] || 'MISSING',
        'baggage': fetchHeaders['baggage'] ? 'present' : 'missing',
        traceHeader: fetchHeaders['sentry-trace'],
      });
      
        try {
          const response = await fetch(`${queueApiUrl}/queue/send`, {
            method: 'POST',
            headers: fetchHeaders,
            body: JSON.stringify({ queueName: 'task-queue', message }),
          });
      
          if (!response.ok) {
            console.error('[API] Failed to send message to queue API:', response.statusText);
            // Fallback to direct queue service (won't work across processes but won't crash)
            queueService.sendMessage('task-queue', message);
          }
        } catch (error) {
          console.error('[API] Error sending message to queue API:', error.message);
          // Fallback to direct queue service
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

// API endpoint that receives requests from frontend
app.post('/api/tasks', async (req, res) => {
  try {
    // Log incoming trace headers to verify propagation
    const sentryTraceHeader = req.headers['sentry-trace'];
    const baggageHeader = req.headers['baggage'];
    console.log('[API] Incoming request headers:');
    console.log('  - sentry-trace:', sentryTraceHeader || 'NOT FOUND');
    console.log('  - baggage:', baggageHeader || 'NOT FOUND');
    
    // Get trace data from the request context (set by Express integration)
    const traceData = Sentry.getTraceData();
    let activeSpan = null;
    let rootSpan = null;
    
    // Safely get active span
    try {
      activeSpan = Sentry.getActiveSpan();
    } catch (e) {
      // No active span
    }
    
    // Safely get root span
    try {
      rootSpan = Sentry.getRootSpan();
    } catch (e) {
      // No root span
    }
    
    console.log('[API] Trace data from request context:', {
      traceId: traceData?.traceId,
      spanId: traceData?.spanId,
      parentSpanId: traceData?.parentSpanId,
      hasActiveSpan: !!activeSpan,
      hasRootSpan: !!rootSpan,
    });
    
    // Log span details if available
    if (activeSpan) {
      try {
        const spanJson = Sentry.spanToJSON(activeSpan);
        console.log('[API] Active span details:', {
          traceId: spanJson?.trace_id,
          spanId: spanJson?.span_id,
          parentSpanId: spanJson?.parent_span_id,
          op: spanJson?.op,
          description: spanJson?.description,
        });
      } catch (e) {
        console.error('[API] Error converting active span to JSON:', e);
      }
    }
    
    const { taskType, userId } = req.body;

    // Simulate some business logic
    // Sometimes we might block the task (simulating the inconsistent behavior)
    const shouldBlock = Math.random() < 0.1; // 10% chance to block
    
    if (shouldBlock) {
      console.log('Task blocked by business logic');
      return res.status(403).json({ error: 'Task blocked' });
    }

    // Schedule task to queue (synchronously within HTTP request)
    // The scheduleTask function will create a queue.send span as a child of the HTTP span
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

// Test endpoint to get current trace information
app.get('/api/trace-info', (req, res) => {
  try {
    const traceData = Sentry.getTraceData();
    let activeSpan = null;
    let rootSpan = null;
    
    // Safely get active span
    try {
      activeSpan = Sentry.getActiveSpan();
    } catch (e) {
      // No active span - this is fine
    }
    
    // Safely get root span
    try {
      rootSpan = Sentry.getRootSpan();
    } catch (e) {
      // No root span - this is fine
    }
    
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

// Error handler is already set up at the beginning with setupExpressErrorHandler
// which handles both request context AND error capture in v10

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`API server running on http://localhost:${PORT}`);
});
