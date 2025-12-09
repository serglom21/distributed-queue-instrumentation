import React, { useState } from 'react';
import './App.css';
import * as Sentry from '@sentry/react';

function App() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  const handleGenerate = async () => {
    setLoading(true);
    setResult(null);
    
    return Sentry.startSpan(
      {
        name: 'Generate Task',
        op: 'ui.action.click',
        attributes: {
          'user.action': 'generate_task',
        },
      },
      async () => {
        try {
          const response = await fetch('http://localhost:3001/api/tasks', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              taskType: 'generate-automatic',
              userId: 'user-123',
            }),
          });

          const data = await response.json();
          console.log('[Frontend] Response:', data);
          setResult(data);
          return data;
        } catch (error) {
          console.error('[Frontend] Error:', error);
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

