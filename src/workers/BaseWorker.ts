import { PrismaClient } from '@prisma/client';
import { createLogger, Logger } from '../utils/logger';

export interface WorkerConfig {
  name: string;
  /** Prisma client for database access */
  prisma: PrismaClient;
  /** Number of items to process per batch */
  batchSize?: number;
  /** Minimum delay between iterations when no work available (ms) */
  idleDelayMs?: number;
  /** Maximum delay for exponential backoff (ms) */
  maxDelayMs?: number;
}

/**
 * Base class for database processing workers.
 * Workers continuously poll for items in a specific state and process them.
 */
export abstract class BaseWorker {
  protected running = false;
  protected logger: Logger;
  protected prisma: PrismaClient;
  protected batchSize: number;
  protected idleDelayMs: number;
  protected maxDelayMs: number;
  protected currentDelay: number;
  private loopPromise: Promise<void> | null = null;

  constructor(protected config: WorkerConfig) {
    this.logger = createLogger(config.name);
    this.prisma = config.prisma;
    this.batchSize = config.batchSize || 10;
    this.idleDelayMs = config.idleDelayMs || 1000;
    this.maxDelayMs = config.maxDelayMs || 30000;
    this.currentDelay = this.idleDelayMs;
  }

  /**
   * Implement this method to process a batch of items.
   * Return the number of items successfully processed.
   */
  protected abstract processBatch(): Promise<number>;

  /**
   * Called once before the loop starts.
   */
  protected async onStart(): Promise<void> {}

  /**
   * Called once after the loop stops.
   */
  protected async onStop(): Promise<void> {}

  /**
   * Start the worker loop.
   */
  async start(): Promise<void> {
    if (this.running) {
      this.logger.warn('Worker is already running');
      return;
    }

    this.running = true;
    await this.onStart();
    this.logger.info('Worker started');

    this.loopPromise = this.loop();
  }

  /**
   * Stop the worker gracefully.
   */
  async stop(): Promise<void> {
    if (!this.running) {
      this.logger.warn('Worker is not running');
      return;
    }

    this.running = false;
    this.logger.info('Stopping worker...');

    if (this.loopPromise) {
      await this.loopPromise;
    }

    await this.onStop();
    this.logger.info('Worker stopped');
  }

  /**
   * Check if the worker is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * The main processing loop.
   */
  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const startTime = Date.now();
        const processedCount = await this.processBatch();
        const duration = Date.now() - startTime;

        if (processedCount > 0) {
          // Reset delay on successful work
          this.currentDelay = this.idleDelayMs;

          this.logger.debug('Batch processed', {
            processed: processedCount,
            durationMs: duration,
          });
        } else {
          // No work, apply backoff
          await this.backoff();
        }
      } catch (error) {
        this.logger.error('Error in worker loop', {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });

        // Apply backoff on error
        await this.backoff();
      }
    }
  }

  /**
   * Apply exponential backoff delay.
   */
  private async backoff(): Promise<void> {
    // Exponential backoff with jitter
    this.currentDelay = Math.min(this.currentDelay * 1.5, this.maxDelayMs);
    const jitter = Math.random() * 0.1 * this.currentDelay;
    const delay = this.currentDelay + jitter;

    await this.delay(delay);
  }

  /**
   * Helper to delay for a given number of milliseconds.
   */
  protected delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
