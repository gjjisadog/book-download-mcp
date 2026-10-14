/**
 * Retry logic with exponential backoff for Z-Library MCP
 * Implements the pattern from .claude/PATTERNS.md
 */

import { logger } from './logger.js';

export interface RetryOptions {
  maxRetries?: number;
  initialDelay?: number;
  maxDelay?: number;
  factor?: number;
  shouldRetry?: (error: any) => boolean;
  onRetry?: (attempt: number, error: any, delay: number) => void;
}

/**
 * Execute an operation with retry logic and exponential backoff
 * @param operation - The async operation to execute
 * @param options - Retry configuration options
 * @returns Promise resolving with the operation result
 * @throws The last error if all retries are exhausted
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxRetries = 3,
    initialDelay = 1000,
    maxDelay = 30000,
    factor = 2,
    shouldRetry = (error) => !error.fatal,
    onRetry,
  } = options;

  let lastError: any;
  let delay = initialDelay;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries || !shouldRetry(error)) {
        throw error;
      }

      // Log retry attempt
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn(`Attempt ${attempt + 1} failed, retrying in ${delay}ms...`, {
        error: errorMessage,
        attempt: attempt + 1,
        maxRetries,
        delay,
      });

      // Call custom retry callback if provided
      if (onRetry) {
        onRetry(attempt + 1, error, delay);
      }

      // Wait before retry
      await new Promise((resolve) => setTimeout(resolve, delay));

      // Calculate next delay with exponential backoff
      delay = Math.min(delay * factor, maxDelay);
    }
  }

  throw lastError;
}

/**
 * Determine if an error is retryable based on error characteristics
 * @param error - The error to classify
 * @returns true if the error should trigger a retry
 */
export function isRetryableError(error: any): boolean {
  if (!error || error.fatal === true || error.retryable === false) return false;
  return [
    'NETWORK_ERROR',
    'TIMEOUT',
    'ECONNREFUSED',
    'ENOTFOUND',
    'ETIMEDOUT',
    'DOMAIN_ERROR',
    'SERVER_ERROR',
    'RATE_LIMITED',
  ].includes(error.code);
}
