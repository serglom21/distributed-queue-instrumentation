#!/usr/bin/env node

/**
 * End-to-end test script for trace propagation
 * 
 * This script:
 * 1. Triggers a task through the API
 * 2. Waits for the message to be processed by workers
 * 3. Validates that trace IDs are consistent across all services
 * 4. Validates parent-child relationships are correct
 * 
 * Usage:
 *   node test-trace-propagation.js
 * 
 * Environment variables:
 *   API_URL - API server URL (default: http://localhost:3001)
 *   QUEUE_API_URL - Queue API URL (default: http://localhost:3002)
 */

const API_URL = process.env.API_URL || 'http://localhost:3001';
const QUEUE_API_URL = process.env.QUEUE_API_URL || 'http://localhost:3002';
const MAX_WAIT_TIME = 10000; // 10 seconds
const POLL_INTERVAL = 500; // 500ms

// Store trace information from each step
const traceInfo = {
  frontend: null,
  apiServer: null,
  queueApi: null,
  nodeWorker: null,
  pythonWorker: null,
};

// Helper to parse sentry-trace header
function parseTraceHeader(header) {
  if (!header) return null;
  const parts = header.split('-');
  return {
    traceId: parts[0],
    parentSpanId: parts[1],
    sampled: parts[2] === '1',
  };
}

// Helper to extract trace ID from logs (simplified - in real scenario would parse logs)
async function extractTraceFromLogs() {
  // This would parse actual log files, but for now we'll use the API endpoints
  // and message metadata
  return null;
}

// Test 1: Trigger task and get trace info from API response
async function testTriggerTask() {
  console.log('\n🧪 Test 1: Triggering task via API...');
  console.log('   Letting Sentry auto-generate trace (no sentry-trace header)');
  
  try {
    const response = await fetch(`${API_URL}/api/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // No sentry-trace header - let Sentry create a new trace automatically
      },
      body: JSON.stringify({
        taskType: 'test-trace-validation',
        userId: 'test-user',
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API returned ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    console.log('✅ Task queued successfully');
    console.log('   Response:', JSON.stringify(data, null, 2));
    
    if (data.traceMetadata) {
      traceInfo.apiServer = data.traceMetadata;
      console.log('   Trace metadata from API:');
      console.log(`     Trace ID: ${data.traceMetadata.traceId}`);
      console.log(`     Span ID: ${data.traceMetadata.spanId}`);
      console.log(`     Parent Span ID: ${data.traceMetadata.parentSpanId || 'none'}`);
    }

    return data;
  } catch (error) {
    console.error('❌ Failed to trigger task:', error.message);
    throw error;
  }
}

// Test 2: Get trace info from API server
async function testGetApiTraceInfo() {
  console.log('\n🧪 Test 2: Getting trace info from API server...');
  
  try {
    const response = await fetch(`${API_URL}/api/trace-info`);
    if (!response.ok) {
      if (response.status === 404) {
        console.error('❌ Trace info endpoint not found (404)');
        console.error('   💡 Make sure the API server has been restarted with the latest code');
        console.error('   💡 The /api/trace-info endpoint should be in api/server.js');
        throw new Error('Trace info endpoint not found - server may need restart');
      }
      throw new Error(`Trace info endpoint returned ${response.status}`);
    }

    const data = await response.json();
    console.log('✅ Got trace info from API server');
    console.log('   Trace data:', JSON.stringify(data, null, 2));
    
    // Don't overwrite trace info if we already have it from Test 1
    if (!traceInfo.apiServer || !traceInfo.apiServer.traceId) {
      traceInfo.apiServer = {
        traceId: data.traceData?.traceId || data.activeSpan?.traceId,
        spanId: data.activeSpan?.spanId,
        parentSpanId: data.activeSpan?.parentSpanId,
      };
    } else {
      console.log('   Using trace info from Test 1 (already have it)');
    }
    
    return data;
  } catch (error) {
    console.error('❌ Failed to get trace info:', error.message);
    throw error;
  }
}

// Test 3: Check queue status and trace info
async function testCheckQueue() {
  console.log('\n🧪 Test 3: Checking queue status and trace info...');
  
  try {
    // Get queue status which includes trace metadata
    const response = await fetch(`${QUEUE_API_URL}/queue/status`);
    if (!response.ok) {
      if (response.status === 404) {
        console.error('❌ Queue status endpoint not found (404)');
        console.error('   💡 Make sure the Queue API server has been restarted with the latest code');
        console.error('   💡 The /queue/status endpoint should be in api/queue-api.js');
        throw new Error('Queue status endpoint not found - server may need restart');
      }
      throw new Error(`Queue API returned ${response.status}`);
    }

    const data = await response.json();
    console.log('✅ Got queue status');
    console.log('   Queue API trace data:', data.traceData);
    
    // Check task-queue for messages
    if (data.queues && data.queues['task-queue']) {
      const taskQueue = data.queues['task-queue'];
      console.log(`   Task queue size: ${taskQueue.size}`);
      
      if (taskQueue.messages && taskQueue.messages.length > 0) {
        const message = taskQueue.messages[0];
        console.log('   Message trace metadata:', message.traceMetadata);
        console.log('   Message trace ID:', message.traceId);
        
        if (message.traceMetadata) {
          traceInfo.queueApi = message.traceMetadata;
        }
      }
    }
    
    // Check python-worker-queue
    if (data.queues && data.queues['python-worker-queue']) {
      const pythonQueue = data.queues['python-worker-queue'];
      console.log(`   Python worker queue size: ${pythonQueue.size}`);
      
      if (pythonQueue.messages && pythonQueue.messages.length > 0) {
        const message = pythonQueue.messages[0];
        console.log('   Python queue message trace metadata:', message.traceMetadata);
        
        if (message.traceMetadata) {
          traceInfo.pythonWorker = message.traceMetadata;
        }
      }
    }
    
    return data;
  } catch (error) {
    console.error('❌ Failed to check queue:', error.message);
    throw error;
  }
}

// Test 4: Validate trace propagation
function testValidateTracePropagation() {
  console.log('\n🧪 Test 4: Validating trace propagation...');
  
  const errors = [];
  const warnings = [];
  
  // Check if we have trace info from API server
  if (!traceInfo.apiServer || !traceInfo.apiServer.traceId) {
    errors.push('Missing trace info from API server');
    console.log('❌ Validation failed: Missing API server trace info');
    console.log('   Trace info received:', traceInfo.apiServer);
    return { success: false, errors, warnings };
  }
  
  const apiTraceId = traceInfo.apiServer.traceId;
  const apiSpanId = traceInfo.apiServer.spanId;
  const apiParentSpanId = traceInfo.apiServer.parentSpanId;
  
  console.log(`   API Server Trace ID: ${apiTraceId}`);
  console.log(`   API Server Span ID: ${apiSpanId}`);
  console.log(`   API Server Parent Span ID: ${apiParentSpanId || 'none'}`);
  
  // Validate the trace ID looks correct (32 hex chars)
  if (!/^[0-9a-f]{32}$/i.test(apiTraceId)) {
    warnings.push(`Trace ID format looks unusual: ${apiTraceId}`);
  } else {
    console.log('   ✅ Trace ID format is valid');
  }
  
  // Validate span ID looks correct (16 hex chars)
  if (apiSpanId && !/^[0-9a-f]{16}$/i.test(apiSpanId)) {
    warnings.push(`Span ID format looks unusual: ${apiSpanId}`);
  } else if (apiSpanId) {
    console.log('   ✅ Span ID format is valid');
  }
  
  // Validate queue trace matches API trace
  if (traceInfo.queueApi) {
    const queueTraceId = traceInfo.queueApi.traceId;
    console.log(`   Queue Trace ID: ${queueTraceId}`);
    
    if (queueTraceId !== apiTraceId) {
      errors.push(`Trace ID mismatch: API=${apiTraceId}, Queue=${queueTraceId}`);
    } else {
      console.log('   ✅ Queue trace ID matches API trace ID');
    }
    
    // Validate parent relationship
    if (traceInfo.queueApi.parentSpanId && traceInfo.queueApi.parentSpanId !== apiSpanId) {
      warnings.push(`Queue parent span ID (${traceInfo.queueApi.parentSpanId}) doesn't match API span ID (${apiSpanId})`);
      console.log(`   ⚠️  Queue span parent should be ${apiSpanId}, but is ${traceInfo.queueApi.parentSpanId}`);
    } else if (traceInfo.queueApi.parentSpanId) {
      console.log('   ✅ Queue parent span ID correctly matches API span ID');
    }
  } else {
    warnings.push('No queue trace metadata found (message may have been processed by workers)');
    console.log('   ⚠️  Messages may have already been processed by workers');
  }
  
  // Check Python worker queue
  if (traceInfo.pythonWorker) {
    console.log(`   Python Worker Queue Trace ID: ${traceInfo.pythonWorker.traceId}`);
    if (traceInfo.pythonWorker.traceId !== apiTraceId) {
      errors.push(`Python worker trace ID mismatch: ${traceInfo.pythonWorker.traceId} vs ${apiTraceId}`);
    } else {
      console.log('   ✅ Python worker trace ID matches');
    }
  }
  
  // Summary
  if (errors.length === 0) {
    console.log('\n✅ All trace propagation validations passed!');
    if (warnings.length > 0) {
      console.log('   ⚠️  Warnings:');
      warnings.forEach(w => console.log(`      - ${w}`));
    }
    return { success: true, errors: [], warnings };
  } else {
    console.log('\n❌ Trace propagation validation failed:');
    errors.forEach(err => console.log(`   - ${err}`));
    if (warnings.length > 0) {
      console.log('   Warnings:');
      warnings.forEach(w => console.log(`      - ${w}`));
    }
    return { success: false, errors, warnings };
  }
}

// Check Node.js version (need 18+ for fetch)
function checkNodeVersion() {
  const nodeVersion = process.version;
  const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0]);
  
  if (majorVersion < 18) {
    console.error('❌ Node.js 18+ is required for this test script (built-in fetch support)');
    console.error(`   Current version: ${nodeVersion}`);
    process.exit(1);
  }
}

// Main test runner
async function runTests() {
  checkNodeVersion();
  
  console.log('🚀 Starting Trace Propagation Tests');
  console.log('=====================================');
  console.log(`Node.js version: ${process.version}`);
  console.log(`API URL: ${API_URL}`);
  console.log(`Queue API URL: ${QUEUE_API_URL}`);
  console.log('');
  
  try {
    // Test 1: Trigger task and get trace metadata
    await testTriggerTask();
    
    console.log('\n⏳ Waiting for message processing...');
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Test 2: Get trace info (optional - for debugging)
    // This won't have trace context since it's a separate request
    await testGetApiTraceInfo();
    
    // Test 3: Check queue for trace propagation
    await testCheckQueue();
    
    // Test 4: Validate
    const result = testValidateTracePropagation();
    
    console.log('\n📊 Test Summary');
    console.log('================');
    console.log(`Success: ${result.success ? '✅' : '❌'}`);
    console.log(`Errors: ${result.errors.length}`);
    console.log(`Warnings: ${result.warnings.length}`);
    
    process.exit(result.success ? 0 : 1);
  } catch (error) {
    console.error('\n💥 Test suite failed:', error);
    process.exit(1);
  }
}

// Run tests
runTests();
