import { PrismaClient, NewsStatus, Prisma } from '@prisma/client';
import { NewsService, NewsItem } from '../types';
import { BaseRunner, RunnerConfig } from './BaseRunner';

export interface NewsServiceRunnerConfig extends RunnerConfig {
  /** The news service to run */
  service: NewsService;
  /** Prisma client for database access */
  prisma: PrismaClient;
}

/**
 * Continuously fetches news from a single news service and saves to database.
 * Each news service should have its own runner instance.
 */
export class NewsServiceRunner extends BaseRunner {
  private service: NewsService;
  private prisma: PrismaClient;

  constructor(config: NewsServiceRunnerConfig) {
    super({
      name: `NewsRunner:${config.service.name}`,
      minDelayMs: config.minDelayMs || 1000,
      maxDelayMs: config.maxDelayMs || 60000,
    });
    this.service = config.service;
    this.prisma = config.prisma;
  }

  protected async runOnce(): Promise<boolean> {
    const startTime = Date.now();

    // Fetch latest news from the service
    const newsItems = await this.service.fetchLatestNews();

    if (newsItems.length === 0) {
      this.logger.debug('No news items fetched');
      return false;
    }

    // Save new items to database
    let savedCount = 0;
    let skippedCount = 0;

    for (const item of newsItems) {
      try {
        const saved = await this.saveNewsItem(item);
        if (saved) {
          savedCount++;
        } else {
          skippedCount++;
        }
      } catch (error) {
        this.logger.error('Failed to save news item', {
          newsId: item.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const duration = Date.now() - startTime;
    this.logger.info('Fetch cycle complete', {
      fetched: newsItems.length,
      saved: savedCount,
      skipped: skippedCount,
      durationMs: duration,
    });

    return savedCount > 0;
  }

  /**
   * Save a news item to the database if it doesn't already exist.
   * Returns true if the item was saved, false if it already existed.
   */
  private async saveNewsItem(item: NewsItem): Promise<boolean> {
    // Validate publishedAt date
    const publishedAt =
      item.publishedAt instanceof Date && !isNaN(item.publishedAt.getTime())
        ? item.publishedAt
        : new Date(); // Use current time as fallback for invalid dates

    // Check if already exists
    const existing = await this.prisma.newsArticle.findUnique({
      where: { externalId: item.id },
      select: { id: true },
    });

    if (existing) {
      return false;
    }

    // Insert new article with PENDING status
    await this.prisma.newsArticle.create({
      data: {
        externalId: item.id,
        source: this.service.name,
        title: item.title,
        content: item.content || null,
        summary: item.summary || null,
        url: item.url || null,
        author: item.author || null,
        publishedAt,
        tags: item.tags || [],
        metadata: item.metadata ? (item.metadata as Prisma.InputJsonValue) : Prisma.JsonNull,
        status: NewsStatus.PENDING,
      },
    });

    this.logger.debug('Saved new article', {
      externalId: item.id,
      title: item.title.substring(0, 50),
    });

    return true;
  }

  protected async onStart(): Promise<void> {
    this.logger.info('Initializing news service', {
      service: this.service.name,
    });
  }

  protected async onStop(): Promise<void> {
    this.logger.info('News service runner stopped', {
      service: this.service.name,
    });
  }
}
