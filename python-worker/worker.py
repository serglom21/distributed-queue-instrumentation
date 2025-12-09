#!/usr/bin/env python3
import os
import time
import requests
import sentry_sdk
from sentry_sdk.integrations.logging import LoggingIntegration
from dotenv import load_dotenv

load_dotenv()
print(f"[Python Worker] DSN loaded: {'YES' if os.getenv('SENTRY_DSN') else 'NO'}")

def before_send(event, hint):
    event_type = event.get('type')
    if event_type == 'transaction' or 'transaction' in event or 'spans' in event:
        if 'sampled' not in event or event.get('sampled') is not True:
            event['sampled'] = True
    return event

sentry_sdk.init(
    dsn=os.getenv("SENTRY_DSN"),
    traces_sample_rate=1.0,
    environment="development",
    debug=True,
    integrations=[
        LoggingIntegration(level=None, event_level=None),
    ],
    before_send=before_send,
)

def process_message(message):
    sentry_trace = message.get('sentryTrace')
    baggage = message.get('baggage')
    
    if sentry_trace:
        headers = {'sentry-trace': sentry_trace}
        if baggage:
            headers['baggage'] = baggage
        
        try:
            trace_envelope = sentry_sdk.continue_trace(headers)
            transaction = sentry_sdk.start_transaction(trace_envelope)
            
            with transaction:
                with sentry_sdk.start_span(
                    op='queue.process',
                    description='python-worker-processing'
                ) as span:
                    time.sleep(0.5)
                    span.set_tag('task.type', message.get('taskType', 'unknown'))
                    span.set_status('ok')
            
            return {'success': True, 'processedBy': 'python-worker'}
        except Exception as e:
            print(f"[Python Worker] Error: {e}")
            sentry_sdk.capture_exception(e)
            return {'success': False, 'error': str(e)}
    else:
        print("[Python Worker] No trace context")
        return {'success': False, 'error': 'No trace context'}

QUEUE_API_URL = os.getenv('QUEUE_API_URL', 'http://localhost:3002')

print(f"[Python Worker] Starting worker, polling {QUEUE_API_URL}")

while True:
    try:
        response = requests.post(
            f'{QUEUE_API_URL}/queue/receive',
            json={'queueName': 'python-worker-queue', 'maxMessages': 1},
            timeout=5
        )
        
        if response.status_code == 200:
            data = response.json()
            messages = data.get('messages', [])
            
            for message in messages:
                try:
                    result = process_message(message)
                    print(f"[Python Worker] Processed: {result}")
                except Exception as e:
                    print(f"[Python Worker] Error processing message: {e}")
                    sentry_sdk.capture_exception(e)
        
        time.sleep(1)
    except Exception as e:
        print(f"[Python Worker] Polling error: {e}")
        time.sleep(5)
