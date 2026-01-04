import { NewsStatus, NewsArticle } from '@prisma/client';
import { EmbeddingService } from '../services/embedding/EmbeddingService';
import { BaseWorker, WorkerConfig } from './BaseWorker';

export interface EmbeddingWorkerConfig extends WorkerConfig {
  /** Embedding service for generating embeddings */
  embeddingService: EmbeddingService;
}

/**
 * Worker that generates embeddings for PENDING news articles.
 * Transitions articles from PENDING -> EMBEDDED status.
 */
export class EmbeddingWorker extends BaseWorker {
  private embeddingService: EmbeddingService;

  constructor(config: EmbeddingWorkerConfig) {
    super({
      ...config,
      name: config.name || 'EmbeddingWorker',
      batchSize: config.batchSize || 10,
    });
    this.embeddingService = config.embeddingService;
  }

  protected async processBatch(): Promise<number> {
    // Fetch PENDING articles
    const articles = await this.prisma.newsArticle.findMany({
      where: { status: NewsStatus.PENDING },
      take: this.batchSize,
      orderBy: { fetchedAt: 'asc' }, // Process oldest first
    });

    if (articles.length === 0) {
      return 0;
    }

    this.logger.debug('Processing articles for embedding', {
      count: articles.length,
    });

    // Generate embeddings
    const texts = articles.map((article) => this.getTextForEmbedding(article));

    let embeddings: number[][];
    try {
      embeddings = await this.embeddingService.generateEmbeddings(texts);
    } catch (error) {
      // Mark all as failed on embedding error
      await this.markBatchFailed(
        articles,
        `Embedding generation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }

    // Update each article with its embedding
    let successCount = 0;
    for (let i = 0; i < articles.length; i++) {
      const article = articles[i];
      const embedding = embeddings[i];

      try {
        if (embedding && embedding.length > 0) {
          // Update with embedding using raw SQL for vector type
          // Note: Must cast status to "NewsStatus" enum type for PostgreSQL
          const vectorStr = `[${embedding.join(',')}]`;
          await this.prisma.$executeRaw`
            UPDATE news_articles
            SET embedding = ${vectorStr}::vector,
                embedded_at = NOW(),
                status = 'EMBEDDED'::"NewsStatus"
            WHERE id = ${article.id}
          `;
          successCount++;
        } else {
          // No embedding returned, mark as failed
          await this.prisma.newsArticle.update({
            where: { id: article.id },
            data: {
              status: NewsStatus.FAILED,
              errorMessage: 'Empty embedding returned',
            },
          });
        }
      } catch (error) {
        this.logger.error('Failed to update article with embedding', {
          articleId: article.id,
          error: error instanceof Error ? error.message : String(error),
        });

        await this.prisma.newsArticle.update({
          where: { id: article.id },
          data: {
            status: NewsStatus.FAILED,
            errorMessage: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }

    this.logger.info('Embedding batch complete', {
      total: articles.length,
      success: successCount,
      failed: articles.length - successCount,
    });

    return successCount;
  }

  /**
   * Create text representation for embedding.
   */
  private getTextForEmbedding(article: NewsArticle): string {
    const parts = [article.title];

    if (article.summary) {
      parts.push(article.summary);
    } else if (article.content) {
      // Use first 500 chars of content if no summary
      parts.push(article.content.substring(0, 500));
    }

    if (article.tags && article.tags.length > 0) {
      parts.push(`Tags: ${article.tags.join(', ')}`);
    }

    return parts.join('\n\n');
  }

  /**
   * Mark a batch of articles as failed.
   */
  private async markBatchFailed(articles: NewsArticle[], errorMessage: string): Promise<void> {
    await this.prisma.newsArticle.updateMany({
      where: { id: { in: articles.map((a) => a.id) } },
      data: {
        status: NewsStatus.FAILED,
        errorMessage,
      },
    });
  }

  protected async onStart(): Promise<void> {
    this.logger.info('Embedding worker initialized');
  }
}
