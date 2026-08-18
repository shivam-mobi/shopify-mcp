/**
 * Streaming Service
 * Provides utilities for handling server-sent events (SSE) streams
 */

/**
 * Creates a StreamManager to handle SSE streams with proper backpressure
 * @param {TextEncoder} encoder - A TextEncoder instance
 * @param {ReadableStreamDefaultController} controller - The stream controller
 * @returns {Object} StreamManager with utility methods for handling streaming
 */
export function createStreamManager(encoder, controller) {
  /**
   * Send a data message to the client
   * @param {Object} data - Data to send
   */
  const sendMessage = (data) => {
    try {
      const text = `data: ${JSON.stringify(data)}\n\n`;
      controller.enqueue(encoder.encode(text));
    } catch (error) {
      console.error('Error sending stream message:', error);
    }
  };

  /**
   * Send an error message to the client
   * @param {Object} error - Error object
   * @param {string} error.type - Error type
   * @param {string} error.error - Error title/message
   * @param {string} error.details - Error details
   */
  const sendError = ({ type, error, details }) => {
    sendMessage({ type, error, details });
  };

  /**
   * Close the stream
   */
  const closeStream = () => {
    try {
      controller.close();
    } catch (error) {
      console.error('Error closing stream:', error);
    }
  };

  /**
   * Handle streaming errors by sending appropriate error messages
   * @param {Error} error - The error that occurred
   */
  const handleStreamingError = (error) => {
    // Log detailed error information for debugging
    console.error('=== LLM API ERROR ===');
    console.error('Error message:', error.message);
    console.error('Error status:', error.status);
    console.error('Full error:', JSON.stringify(error, null, 2));
    console.error('========================');

    if (error.status === 401 || error.status === 403 || error.message?.includes('API key') || error.message?.includes('API_KEY') || error.message?.includes('auth')) {
      sendError({
        type: 'error',
        error: 'Authentication failed with the LLM provider',
        details: 'Please check LLM_PROVIDER and the matching API key in .env'
      });
    } else if (error.status === 429 || error.status === 529 || error.message?.includes('RESOURCE_EXHAUSTED') || error.message?.includes('Overloaded') || error.message?.includes('quota')) {
      sendError({
        type: 'rate_limit_exceeded',
        error: 'Rate limit exceeded',
        details: 'Please try again later'
      });
    } else if (error.message?.includes('billing') || error.message?.includes('credit')) {
      sendError({
        type: 'error',
        error: 'LLM billing or quota issue',
        details: error.message
      });
    } else {
      sendError({
        type: 'error',
        error: 'Failed to get a response from the LLM provider',
        details: error.message || 'Unknown error occurred'
      });
    }
  };

  return {
    sendMessage,
    sendError,
    closeStream,
    handleStreamingError
  };
}

/**
 * Creates a ReadableStream for SSE
 * @param {Function} streamHandler - Async function that handles the stream
 * @returns {ReadableStream} A readable stream for SSE
 */
export function createSseStream(streamHandler) {
  const encoder = new TextEncoder();
  
  return new ReadableStream({
    async start(controller) {
      const streamManager = createStreamManager(encoder, controller);
      
      try {
        await streamHandler(streamManager);
      } catch (error) {
        streamManager.handleStreamingError(error);
      } finally {
        streamManager.closeStream();
      }
    }
  });
}

export default {
  createSseStream,
  createStreamManager
};