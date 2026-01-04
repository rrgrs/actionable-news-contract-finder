import { createLogger, Logger } from '../utils/logger';

export interface RunnerConfig {
  name: string;
  /** Minimum delay between loop iterations in ms (for backoff on errors) */
  minDelayMs?: number;
  /** Maximum delay for exponential backoff in ms */
  maxDelayMs?: number;
}

/**
 * Base class for continuous loop runners.
 * Subclasses implement runOnce() which is called continuously.
 */
export abstract class BaseRunner {
  protected running = false;
  protected logger: Logger;
  protected currentDelay: number;
  private loopPromise: Promise<void> | null = null;

  constructor(protected config: RunnerConfig) {
    this.logger = createLogger(config.name);
    this.currentDelay = config.minDelayMs || 0;
  }

  /**
   * Implement this method to define what happens in each loop iteration.
   * Return true if work was done, false if no work was available.
   */
  protected abstract runOnce(): Promise<boolean>;

  /**
   * Called once before the loop starts.
   */
  protected async onStart(): Promise<void> {}

  /**
   * Called once after the loop stops.
   */
  protected async onStop(): Promise<void> {}

  /**
   * Start the continuous loop.
   */
  async start(): Promise<void> {
    if (this.running) {
      this.logger.warn('Runner is already running');
      return;
    }

    this.running = true;
    await this.onStart();
    this.logger.info('Runner started');

    this.loopPromise = this.loop();
  }

  /**
   * Stop the continuous loop gracefully.
   */
  async stop(): Promise<void> {
    if (!this.running) {
      this.logger.warn('Runner is not running');
      return;
    }

    this.running = false;
    this.logger.info('Stopping runner...');

    // Wait for current iteration to complete
    if (this.loopPromise) {
      await this.loopPromise;
    }

    await this.onStop();
    this.logger.info('Runner stopped');
  }

  /**
   * Check if the runner is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * The main loop that runs continuously.
   */
  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const startTime = Date.now();
        const didWork = await this.runOnce();
        const duration = Date.now() - startTime;

        if (didWork) {
          // Reset delay on successful work
          this.currentDelay = this.config.minDelayMs || 0;

          this.logger.debug('Loop iteration complete', { durationMs: duration });
        } else {
          // No work available, apply backoff
          await this.backoff();
        }
      } catch (error) {
        this.logger.error('Error in loop iteration', {
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
    const minDelay = this.config.minDelayMs || 1000;
    const maxDelay = this.config.maxDelayMs || 30000;

    // Exponential backoff with jitter
    this.currentDelay = Math.min(this.currentDelay * 2 || minDelay, maxDelay);
    const jitter = Math.random() * 0.1 * this.currentDelay;
    const delay = this.currentDelay + jitter;

    this.logger.debug('Backing off', { delayMs: Math.round(delay) });
    await this.delay(delay);
  }

  /**
   * Helper to delay for a given number of milliseconds.
   */
  protected delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
