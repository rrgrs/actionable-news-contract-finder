import { AxiosError } from 'axios';
import { Logger, createLogger } from './logger';

export interface RateLimitConfig {
  /** Minimum delay between requests in milliseconds */
  minDelayMs: number;
  /** Maximum requests per minute (sliding window) */
  requestsPerMinute?: number;
  /** Maximum retry attempts on rate limit errors */
  maxRetries?: number;
  /** Base delay for exponential backoff in milliseconds */
  baseBackoffMs?: number;
  /** Maximum backoff delay in milliseconds */
  maxBackoffMs?: number;
}

export interface RateLimitState {
  /** Timestamp of last request */
  lastRequestTime: number;
  /** Sliding window of request timestamps */
  requestTimes: number[];
  /** Current retry count (reset on success) */
  retryCount: number;
  /** Timestamp when rate limit resets (from headers) */
  resetTime?: number;
  /** Remaining requests (from headers) */
  remaining?: number;
}

/**
 * Unified rate limiter utility for API requests.
 * Supports minimum delays, sliding window limits, and exponential backoff.
 */
export class RateLimiter {
  private config: Required<RateLimitConfig>;
  private state: RateLimitState;
  private logger: Logger;

  constructor(config: RateLimitConfig, serviceName: string = 'RateLimiter') {
    this.config = {
      minDelayMs: config.minDelayMs,
      requestsPerMinute: config.requestsPerMinute ?? 0,
      maxRetries: config.maxRetries ?? 5,
      baseBackoffMs: config.baseBackoffMs ?? 1000,
      maxBackoffMs: config.maxBackoffMs ?? 30000,
    };

    this.state = {
      lastRequestTime: 0,
      requestTimes: [],
      retryCount: 0,
    };

    this.logger = createLogger(serviceName);
  }

  /**
   * Wait for rate limit requirements before making a request.
   * Call this before each API request.
   */
  async beforeRequest(): Promise<void> {
    const now = Date.now();

    // Clean up old request times (older than 1 minute)
    if (this.config.requestsPerMinute > 0) {
      this.state.requestTimes = this.state.requestTimes.filter((time) => now - time < 60000);

      // Check sliding window limit
      if (this.state.requestTimes.length >= this.config.requestsPerMinute) {
        const oldestRequest = Math.min(...this.state.requestTimes);
        const waitTime = 60000 - (now - oldestRequest) + 100; // Add small buffer
        if (waitTime > 0) {
          this.logger.debug('Sliding window rate limit reached, waiting', {
            currentRequests: this.state.requestTimes.length,
            limit: this.config.requestsPerMinute,
            waitMs: waitTime,
          });
          await this.delay(waitTime);
        }
      }
    }

    // Enforce minimum delay between requests
    const timeSinceLastRequest = Date.now() - this.state.lastRequestTime;
    if (timeSinceLastRequest < this.config.minDelayMs) {
      const delayTime = this.config.minDelayMs - timeSinceLastRequest;
      await this.delay(delayTime);
    }

    // Track this request
    this.state.lastRequestTime = Date.now();
    if (this.config.requestsPerMinute > 0) {
      this.state.requestTimes.push(Date.now());
    }
  }

  /**
   * Call after a successful request to reset retry state.
   */
  onSuccess(): void {
    this.state.retryCount = 0;
  }

  /**
   * Handle a rate limit error (HTTP 429).
   * Returns true if should retry, false if max retries exceeded.
   */
  async onRateLimitError(error: AxiosError): Promise<boolean> {
    this.state.retryCount++;

    if (this.state.retryCount > this.config.maxRetries) {
      this.logger.error('Max retries exceeded for rate limit', {
        retries: this.state.retryCount - 1,
        maxRetries: this.config.maxRetries,
      });
      return false;
    }

    // Calculate backoff time
    let waitTime = this.calculateBackoff(this.state.retryCount);

    // Check for Retry-After header
    const retryAfter = error.response?.headers?.['retry-after'];
    if (retryAfter) {
      const headerWaitTime = parseInt(String(retryAfter), 10) * 1000;
      if (!isNaN(headerWaitTime) && headerWaitTime > 0) {
        waitTime = Math.max(waitTime, headerWaitTime);
      }
    }

    // Update rate limit info from headers
    this.updateFromHeaders(error.response?.headers);

    this.logger.warn('Rate limited, backing off', {
      attempt: this.state.retryCount,
      maxRetries: this.config.maxRetries,
      waitMs: waitTime,
      retryAfterHeader: retryAfter,
    });

    await this.delay(waitTime);
    return true;
  }

  /**
   * Check if an error is a rate limit error (HTTP 429).
   */
  isRateLimitError(error: unknown): error is AxiosError {
    if (typeof error === 'object' && error !== null && 'isAxiosError' in error) {
      const axiosError = error as AxiosError;
      return axiosError.response?.status === 429;
    }
    return false;
  }

  /**
   * Update internal state from response headers.
   */
  updateFromHeaders(headers?: Record<string, unknown>): void {
    if (!headers) {
      return;
    }

    // Common rate limit header patterns
    const remaining =
      headers['x-ratelimit-remaining'] ??
      headers['x-rate-limit-remaining'] ??
      headers['ratelimit-remaining'];

    const reset =
      headers['x-ratelimit-reset'] ?? headers['x-rate-limit-reset'] ?? headers['ratelimit-reset'];

    if (remaining !== undefined) {
      this.state.remaining = parseInt(String(remaining), 10);
    }

    if (reset !== undefined) {
      const resetValue = parseInt(String(reset), 10);
      // Handle both Unix timestamps and seconds-until-reset
      this.state.resetTime =
        resetValue > 1000000000 ? resetValue * 1000 : Date.now() + resetValue * 1000;
    }
  }

  /**
   * Get current rate limit state for monitoring.
   */
  getState(): Readonly<RateLimitState> {
    return { ...this.state };
  }

  /**
   * Reset the rate limiter state.
   */
  reset(): void {
    this.state = {
      lastRequestTime: 0,
      requestTimes: [],
      retryCount: 0,
    };
  }

  private calculateBackoff(attempt: number): number {
    const backoff = this.config.baseBackoffMs * Math.pow(2, attempt - 1);
    return Math.min(backoff, this.config.maxBackoffMs);
  }

  private delay(ms: number): Promise<void> {
    // Skip delays in test environment
    if (process.env.NODE_ENV === 'test') {
      return Promise.resolve();
    }
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Execute a function with rate limiting and automatic retry on 429 errors.
 */
export async function withRateLimit<T>(rateLimiter: RateLimiter, fn: () => Promise<T>): Promise<T> {
  while (true) {
    await rateLimiter.beforeRequest();

    try {
      const result = await fn();
      rateLimiter.onSuccess();
      return result;
    } catch (error) {
      if (rateLimiter.isRateLimitError(error)) {
        const shouldRetry = await rateLimiter.onRateLimitError(error);
        if (!shouldRetry) {
          throw new Error('Rate limit exceeded after maximum retries');
        }
        // Continue loop to retry
      } else {
        throw error;
      }
    }
  }
}
