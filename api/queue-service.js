// Mock SQS queue service (in-memory for demo)
// This is a shared instance that can be accessed by both Node.js and Python workers
class QueueService {
  constructor() {
    this.queues = new Map();
    this.listeners = new Map();
    this.pendingMessages = new Map(); // Track pending messages per queue
  }

  sendMessage(queueName, message) {
    if (!this.queues.has(queueName)) {
      this.queues.set(queueName, []);
    }
    
    const messageWithMetadata = {
      ...message,
      MessageId: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      ReceiptHandle: `receipt-${Date.now()}`,
      Attributes: {
        SentTimestamp: Date.now().toString(),
      },
    };
    
    const queue = this.queues.get(queueName);
    queue.push(messageWithMetadata);

    console.log(`[Queue] Message sent to ${queueName}:`, {
      messageId: messageWithMetadata.MessageId,
      hasTrace: !!message.sentryTrace,
      hasBaggage: !!message.baggage,
      traceId: message.sentryTrace?.split('-')[0],
    });

    // Notify listeners
    const listeners = this.listeners.get(queueName) || [];
    if (listeners.length > 0) {
      // Deliver to first available listener
      setImmediate(() => {
        const messages = this.queues.get(queueName) || [];
        const message = messages.shift();
        if (message) {
          // Deliver to all listeners (simulating multiple workers)
          listeners.forEach(listener => {
            try {
              listener(message);
            } catch (error) {
              console.error(`[Queue] Error delivering message to listener:`, error);
            }
          });
        }
      });
    }
  }

  receiveMessage(queueName, callback) {
    if (!this.listeners.has(queueName)) {
      this.listeners.set(queueName, []);
    }
    this.listeners.get(queueName).push(callback);
    
    // Process any existing messages in the queue
    const messages = this.queues.get(queueName) || [];
    if (messages.length > 0) {
      setImmediate(() => {
        const message = messages.shift();
        if (message) {
          try {
            callback(message);
          } catch (error) {
            console.error(`[Queue] Error processing existing message:`, error);
          }
        }
      });
    }
  }

  getQueue(queueName) {
    return this.queues.get(queueName) || [];
  }

  // Method to get messages (for Python worker via HTTP API)
  getMessages(queueName, maxMessages = 1) {
    const queue = this.queues.get(queueName) || [];
    return queue.splice(0, maxMessages);
  }
}

export const queueService = new QueueService();

