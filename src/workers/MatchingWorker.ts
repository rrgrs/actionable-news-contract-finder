import { NewsStatus, NewsArticle } from '@prisma/client';
import { BaseWorker, WorkerConfig } from './BaseWorker';

export interface MatchingWorkerConfig extends WorkerConfig {
  /** Number of top similar markets to match per article */
  topN?: number;
  /** Minimum similarity score to consider a match */
  minSimilarity?: number;
}

interface SimilarMarket {
  market_id: number;
  similarity: number;
}

/**
 * Worker that finds similar markets for EMBEDDED news articles.
 * Uses pgvector cosine similarity to find matching markets.
 * Transitions articles from EMBEDDED -> MATCHED status.
 */
export class MatchingWorker extends BaseWorker {
  private topN: number;
  private minSimilarity: number;

  constructor(config: MatchingWorkerConfig) {
    super({
      ...config,
      name: config.name || 'MatchingWorker',
      batchSize: config.batchSize || 5, // Smaller batches for matching
    });
    this.topN = config.topN || 20;
    this.minSimilarity = config.minSimilarity || 0.3;
  }

  protected async processBatch(): Promise<number> {
    // Fetch EMBEDDED articles
    const articles = await this.prisma.newsArticle.findMany({
      where: { status: NewsStatus.EMBEDDED },
      take: this.batchSize,
      orderBy: { embeddedAt: 'asc' }, // Process oldest first
    });

    if (articles.length === 0) {
      return 0;
    }

    this.logger.debug('Processing articles for matching', {
      count: articles.length,
    });

    let successCount = 0;

    for (const article of articles) {
      try {
        const matchCount = await this.findAndSaveMatches(article);
        successCount++;

        this.logger.debug('Found matches for article', {
          articleId: article.id,
          title: article.title.substring(0, 50),
          matchCount,
        });
      } catch (error) {
        this.logger.error('Failed to match article', {
          articleId: article.id,
          error: error instanceof Error ? error.message : String(error),
        });

        await this.prisma.newsArticle.update({
          where: { id: article.id },
          data: {
            status: NewsStatus.FAILED,
            errorMessage: `Matching failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        });
      }
    }

    return successCount;
  }

  /**
   * Find similar markets and save matches for an article.
   */
  private async findAndSaveMatches(article: NewsArticle): Promise<number> {
    // Find similar markets using pgvector cosine similarity
    const similarMarkets = await this.prisma.$queryRaw<SimilarMarket[]>`
      SELECT
        m.id as market_id,
        1 - (m.embedding <=> (
          SELECT embedding FROM news_articles WHERE id = ${article.id}
        )) as similarity
      FROM markets m
      WHERE m.is_active = true
        AND m.embedding IS NOT NULL
      ORDER BY m.embedding <=> (
        SELECT embedding FROM news_articles WHERE id = ${article.id}
      )
      LIMIT ${this.topN}
    `;

    // Filter by minimum similarity
    const matches = similarMarkets.filter((m) => m.similarity >= this.minSimilarity);

    if (matches.length === 0) {
      // No matches, but still mark as matched (0 matches is valid)
      await this.prisma.newsArticle.update({
        where: { id: article.id },
        data: {
          status: NewsStatus.MATCHED,
          matchedAt: new Date(),
        },
      });
      return 0;
    }

    // Create match records
    await this.prisma.newsMarketMatch.createMany({
      data: matches.map((m) => ({
        newsArticleId: article.id,
        marketId: m.market_id,
        similarity: m.similarity,
      })),
      skipDuplicates: true,
    });

    // Update article status
    await this.prisma.newsArticle.update({
      where: { id: article.id },
      data: {
        status: NewsStatus.MATCHED,
        matchedAt: new Date(),
      },
    });

    return matches.length;
  }

  protected async onStart(): Promise<void> {
    this.logger.info('Matching worker initialized', {
      topN: this.topN,
      minSimilarity: this.minSimilarity,
    });
  }
}
