#!/usr/bin/env python3
"""
Python worker that processes messages from the queue.
This simulates the GPU processing work mentioned in the transcript.
"""

import os
import time
import json
import requests
import sentry_sdk
from sentry_sdk.integrations.logging import LoggingIntegration
from dotenv import load_dotenv

# Load .env file
load_dotenv()
print(f"[Python Worker] DSN loaded: {'YES' if os.getenv('SENTRY_DSN') else 'NO'}")

# Initialize Sentry
def before_send(event, hint):
    """Force all transactions to be sent (prevent client-side discarding)."""
    event_type = event.get('type')
    print(f"[Python Worker] before_send called with event type: {event_type}")
    
    # Check if this is a transaction event
    # Transactions have type='transaction' or have a 'transaction' field
    if event_type == 'transaction' or 'transaction' in event or 'spans' in event:
        print(f"[Python Worker] before_send: Processing transaction event")
        print(f"  - Event keys: {list(event.keys())}")
        print(f"  - Current sampled: {event.get('sampled')}")
        
        # Force sampling by ensuring sampled flag is set
        if 'sampled' not in event or event.get('sampled') is not True:
            event['sampled'] = True
            print(f"[Python Worker] ✓ before_send: Forced sampled=True for transaction {event.get('transaction', 'unknown')}")
        else:
            print(f"[Python Worker] before_send: Transaction already sampled")
    else:
        print(f"[Python Worker] before_send: Not a transaction event, skipping")
    
    return event

sentry_sdk.init(
    dsn=os.getenv("SENTRY_DSN"),
    traces_sample_rate=1.0,
    environment="development",
    debug=True,  # Enable debug logging to see what's being sent
    integrations=[
        LoggingIntegration(level=None, event_level=None),
    ],
    before_send=before_send,
)

# Use HTTP API to access queue (since we can't easily share in-memory queue between Node.js and Python)


def process_message(message):
    """Process a message from the queue with trace continuation."""
    print(f"[Python Worker] ===== Processing message =====")
    print(f"[Python Worker] MessageId: {message.get('MessageId')}")
    print(f"[Python Worker] Sentry trace: {message.get('sentryTrace')}")
    print(f"[Python Worker] Baggage: {message.get('baggage')}")
    print(f"[Python Worker] Has trace: {bool(message.get('sentryTrace'))}")
    print(f"[Python Worker] Has baggage: {bool(message.get('baggage'))}")
    
    # Continue trace from message
    sentry_trace = message.get('sentryTrace')
    baggage = message.get('baggage')
    
    # Parse trace ID for debugging
    if sentry_trace:
        parts = sentry_trace.split('-')
        print(f"[Python Worker] Parsed trace header:")
        print(f"  - Trace ID: {parts[0] if len(parts) > 0 else 'N/A'}")
        print(f"  - Parent Span ID: {parts[1] if len(parts) > 1 else 'N/A'}")
        print(f"  - Sampled: {parts[2] if len(parts) > 2 else 'N/A'}")
    
    if sentry_trace:
        # Create headers dict for trace continuation
        headers = {'sentry-trace': sentry_trace}
        if baggage:
            headers['baggage'] = baggage
        
        print(f"[Python Worker] Headers for continue_trace: {headers}")
        
        # Parse trace header to extract trace context
        trace_parts = sentry_trace.split('-')
        trace_id = trace_parts[0] if len(trace_parts) > 0 else None
        parent_span_id = trace_parts[1] if len(trace_parts) > 1 else None
        trace_sampled_flag = trace_parts[2] if len(trace_parts) > 2 else None
        
        print(f"[Python Worker] Parsed trace context:")
        print(f"  - Trace ID: {trace_id}")
        print(f"  - Parent Span ID: {parent_span_id}")
        print(f"  - Sampled flag: {trace_sampled_flag}")
        
        # Parse the trace header to check sampled status
        trace_sampled = trace_sampled_flag == '1'
        
        print(f"[Python Worker] Using continue_trace to set context, then start_span")
        print(f"  - Trace ID: {trace_id}")
        print(f"  - Parent Span ID: {parent_span_id}")
        print(f"  - Sampled: {trace_sampled}")
        
        try:
            # In Sentry Python SDK, continue_trace returns the transaction envelope
            # We must call start_transaction on it explicitly
            trace_envelope = sentry_sdk.continue_trace(headers)
            print(f"[Python Worker] Trace envelope from continue_trace: {trace_envelope}")
            
            # Start the transaction using the envelope from continue_trace
            # This is the ONLY way to properly continue traces in Python SDK
            transaction = sentry_sdk.start_transaction(trace_envelope)
            
            with transaction:
                    print(f"[Python Worker] Span created: {transaction}")
                    print(f"[Python Worker] Span trace_id: {transaction.trace_id if hasattr(transaction, 'trace_id') else 'N/A'}")
                    print(f"[Python Worker] Span span_id: {transaction.span_id if hasattr(transaction, 'span_id') else 'N/A'}")
                    print(f"[Python Worker] Span parent_span_id: {transaction.parent_span_id if hasattr(transaction, 'parent_span_id') else 'N/A'}")
                    print(f"[Python Worker] Span sampled: {transaction.sampled if hasattr(transaction, 'sampled') else 'N/A'}")
                    
                    # Simulate GPU work
                    print(f"[Python Worker] Starting GPU work for task: {message.get('taskType')}")
                    
                    # Simulate processing time
                    time.sleep(0.5)
                    
                    # Add some spans for GPU operations
                    with sentry_sdk.start_span(op="gpu.inference", description="athena-turbo"):
                        print("[Python Worker] Running GPU inference...")
                        time.sleep(0.3)
                    
                    print("[Python Worker] GPU work completed")
                    transaction.set_tag("task.type", message.get('taskType', 'unknown'))
                    transaction.set_tag("processed.by", "python-worker")
                    
                    # Get span info before finishing
                    span_info = {
                        "trace_id": transaction.trace_id if hasattr(transaction, 'trace_id') else None,
                        "span_id": transaction.span_id if hasattr(transaction, 'span_id') else None,
                        "parent_span_id": transaction.parent_span_id if hasattr(transaction, 'parent_span_id') else None,
                    }
                    print(f"[Python Worker] Span info before finish: {span_info}")
                    
                    # Span will be finished automatically when context manager exits
                    # Flush Sentry to ensure it's sent immediately
                    print("[Python Worker] Flushing Sentry...")
                    flushed = sentry_sdk.flush(timeout=2.0)
                    print(f"[Python Worker] Sentry flush result: {flushed}")
                    
                    return {
                        "success": True,
                        "processedBy": "python-worker",
                        "processedAt": time.time(),
                        "span": span_info,
                    }
        except Exception as e:
            print(f"[Python Worker] ERROR in continue_trace: {e}")
            import traceback
            traceback.print_exc()
            raise
    else:
        print("[Python Worker] WARNING: No sentry trace found in message!")
        # Still process but without trace context
        time.sleep(0.5)
        return {
            "success": True,
            "processedBy": "python-worker",
            "processedAt": time.time(),
            "warning": "no_trace_context",
        }


def main():
    """Main worker loop."""
    print("[Python Worker] Starting worker...")
    queue_api_url = os.getenv("QUEUE_API_URL", "http://localhost:3002")
    
    # Poll for messages
    print("[Python Worker] Polling for messages on python-worker-queue...")
    try:
        while True:
            try:
                # Poll queue API for messages
                response = requests.post(
                    f"{queue_api_url}/queue/receive",
                    json={"queueName": "python-worker-queue", "maxMessages": 1},
                    timeout=5
                )
                
                if response.status_code == 200:
                    data = response.json()
                    messages = data.get("messages", [])
                    
                    for message in messages:
                        try:
                            result = process_message(message)
                            print(f"[Python Worker] Message processed: {result}")
                        except Exception as e:
                            print(f"[Python Worker] Error processing message: {e}")
                            sentry_sdk.capture_exception(e)
                else:
                    print(f"[Python Worker] Queue API returned status {response.status_code}")
                    
            except requests.exceptions.RequestException as e:
                print(f"[Python Worker] Error polling queue: {e}")
            
            # Poll every second
            time.sleep(1)
            
    except KeyboardInterrupt:
        print("[Python Worker] Shutting down...")


if __name__ == "__main__":
    main()

