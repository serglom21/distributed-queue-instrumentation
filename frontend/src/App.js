import React, { useState } from 'react';
import './App.css';
import * as Sentry from '@sentry/react';

function App() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  const handleGenerate = async () => {
    setLoading(true);
    setResult(null);
    
    // CRITICAL: Create a transaction for this user interaction
    // This ensures we have a root transaction that all other spans will be children of
    return Sentry.startSpan(
      {
        name: 'Generate Task',
        op: 'user.action',
        attributes: {
          'user.action': 'generate_task',
        },
      },
      async () => {
        try {
          // Create a child span for the HTTP request
          // CRITICAL: Get trace headers from THIS span (the HTTP client span), not the parent
          return Sentry.startSpan(
            {
              name: 'POST /api/tasks',
              op: 'http.client',
            },
            async (httpSpan) => {
              // Build headers with trace propagation
              const headers = {
                'Content-Type': 'application/json',
              };
              
              // CRITICAL: Get trace header from the HTTP client span itself
              // This ensures the backend receives the HTTP span's ID as the parent
              const traceHeader = Sentry.spanToTraceHeader(httpSpan);
              if (traceHeader) {
                headers['sentry-trace'] = traceHeader;
                console.log('[Frontend] Added sentry-trace header from HTTP span:', traceHeader);
              }
              
              // Also get baggage from the HTTP span
              const baggageHeader = Sentry.spanToBaggageHeader(httpSpan);
              if (baggageHeader) {
                headers['baggage'] = baggageHeader;
                console.log('[Frontend] Added baggage header from HTTP span:', baggageHeader);
              }
              
              // Fallback: try active span if httpSpan didn't work
              if (!headers['sentry-trace']) {
                const activeSpan = Sentry.getActiveSpan();
                if (activeSpan) {
                  const fallbackHeader = Sentry.spanToTraceHeader(activeSpan);
                  if (fallbackHeader) {
                    headers['sentry-trace'] = fallbackHeader;
                    console.log('[Frontend] Fallback: Added sentry-trace header from active span:', fallbackHeader);
                  }
                }
              }
              
              console.log('[Frontend] Request headers:', headers);
              
              const response = await fetch('http://localhost:3001/api/tasks', {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({
                  taskType: 'generate',
                  userId: 'user-123',
                }),
              });

              const data = await response.json();
              setResult(data);
              return data;
            }
          );
        } catch (error) {
          console.error('Error:', error);
          setResult({ error: error.message });
          Sentry.captureException(error);
          throw error;
        } finally {
          setLoading(false);
        }
      }
    );
  };

  return (
    <div className="App">
      <header className="App-header">
        <h1>Queue Instrumentation Demo</h1>
        <p>Click the button to trigger a task that goes through the queue system</p>
        <button onClick={handleGenerate} disabled={loading}>
          {loading ? 'Generating...' : 'Generate Task'}
        </button>
        {result && (
          <div className="result">
            <pre>{JSON.stringify(result, null, 2)}</pre>
          </div>
        )}
      </header>
    </div>
  );
}

export default App;

