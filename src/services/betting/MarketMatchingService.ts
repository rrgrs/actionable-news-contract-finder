import { PrismaClient, Market as PrismaMarket, Contract as PrismaContract } from '@prisma/client';
import { EmbeddingService } from '../embedding/EmbeddingService';
import { NewsItem, MatchedMarket } from '../../types';
import { createLogger } from '../../utils/logger';
import { prismaMarketWithContractsToMarketWithContracts } from '../../lib/marketHelpers';

export interface MarketMatchConfig {
  topN: number; // Number of top matches to return (default: 50)
  minSimilarity?: number; // Minimum similarity threshold (optional)
}

type PrismaMarketWithContracts = PrismaMarket & { contracts: PrismaContract[] };

// Raw result from pgvector similarity query
interface SimilarMarketRow {
  id: number;
  platform: string;
  event_ticker: string;
  series_ticker: string | null;
  title: string;
  url: string;
  category: string | null;
  end_date: Date | null;
  is_active: boolean;
  last_synced_at: Date;
  created_at: Date;
  updated_at: Date;
  similarity: number;
}

/**
 * Service that matches news articles to markets using vector similarity.
 * Uses pgvector for database-level similarity search.
 * Returns matched markets with all their contracts included.
 */
export class MarketMatchingService {
  private logger = createLogger('MarketMatchingService');

  constructor(
    private prisma: PrismaClient,
    private embeddingService: EmbeddingService,
    private config: MarketMatchConfig,
  ) {}

  /**
   * Initialize the matching service
   */
  async initialize(): Promise<void> {
    this.logger.info('MarketMatchingService initialized', {
      topN: this.config.topN,
      minSimilarity: this.config.minSimilarity,
    });
  }

  /**
   * Find the top N most similar markets for a news item using pgvector
   */
  async findMatchingMarkets(newsItem: NewsItem): Promise<MatchedMarket[]> {
    // Generate embedding for the news item
    const newsText = this.getNewsTextForEmbedding(newsItem);
    const newsEmbedding = await this.embeddingService.generateEmbedding(newsText);

    if (!newsEmbedding || newsEmbedding.length === 0) {
      this.logger.error('Failed to generate embedding for news item', {
        newsId: newsItem.id,
      });
      return [];
    }

    // Use pgvector for similarity search at database level
    const vectorStr = `[${newsEmbedding.join(',')}]`;
    const minSimilarity = this.config.minSimilarity ?? 0;

    // Query similar markets using cosine distance operator (<=>)
    // 1 - distance = similarity for cosine
    const similarMarkets = await this.prisma.$queryRaw<SimilarMarketRow[]>`
      SELECT
        id, platform, event_ticker, series_ticker, title, url,
        category, end_date, is_active, last_synced_at, created_at, updated_at,
        1 - (embedding <=> ${vectorStr}::vector) AS similarity
      FROM markets
      WHERE is_active = true
        AND embedding IS NOT NULL
        AND 1 - (embedding <=> ${vectorStr}::vector) >= ${minSimilarity}
      ORDER BY embedding <=> ${vectorStr}::vector
      LIMIT ${this.config.topN}
    `;

    if (similarMarkets.length === 0) {
      this.logger.debug('No similar markets found', { newsId: newsItem.id });
      return [];
    }

    // Fetch contracts for matched markets
    const marketIds = similarMarkets.map((m) => m.id);
    const contracts = await this.prisma.contract.findMany({
      where: {
        marketId: { in: marketIds },
        isActive: true,
      },
    });

    // Group contracts by market ID
    const contractsByMarketId = new Map<number, PrismaContract[]>();
    for (const contract of contracts) {
      const existing = contractsByMarketId.get(contract.marketId) || [];
      existing.push(contract);
      contractsByMarketId.set(contract.marketId, existing);
    }

    // Convert to MatchedMarket format
    const matchedMarkets: MatchedMarket[] = similarMarkets.map((row) => {
      const market: PrismaMarketWithContracts = {
        id: row.id,
        platform: row.platform,
        eventTicker: row.event_ticker,
        seriesTicker: row.series_ticker,
        title: row.title,
        url: row.url,
        category: row.category,
        endDate: row.end_date,
        isActive: row.is_active,
        embeddingUpdatedAt: null,
        lastSyncedAt: row.last_synced_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        contracts: contractsByMarketId.get(row.id) || [],
      };

      const marketWithContracts = prismaMarketWithContractsToMarketWithContracts(market);
      return {
        market: marketWithContracts,
        contracts: marketWithContracts.contracts,
        similarity: row.similarity,
      };
    });

    this.logger.debug('Found matching markets', {
      newsId: newsItem.id,
      newsTitle: newsItem.title.substring(0, 50),
      matchCount: matchedMarkets.length,
      topSimilarity: matchedMarkets[0]?.similarity.toFixed(4),
    });

    return matchedMarkets;
  }

  /**
   * Find matching markets for multiple news items (batch processing)
   * Uses pgvector for database-level similarity search
   */
  async findMatchingMarketsForBatch(newsItems: NewsItem[]): Promise<Map<string, MatchedMarket[]>> {
    const results = new Map<string, MatchedMarket[]>();

    // Generate embeddings for all news items in batch
    const newsTexts = newsItems.map((item) => this.getNewsTextForEmbedding(item));
    const newsEmbeddings = await this.embeddingService.generateEmbeddings(newsTexts);

    // Process each news item with its embedding
    for (let i = 0; i < newsItems.length; i++) {
      const newsItem = newsItems[i];
      const newsEmbedding = newsEmbeddings[i];

      if (!newsEmbedding || newsEmbedding.length === 0) {
        this.logger.warn('Empty embedding for news item', { newsId: newsItem.id });
        results.set(newsItem.id, []);
        continue;
      }

      // Use pgvector for similarity search
      const vectorStr = `[${newsEmbedding.join(',')}]`;
      const minSimilarity = this.config.minSimilarity ?? 0;

      const similarMarkets = await this.prisma.$queryRaw<SimilarMarketRow[]>`
        SELECT
          id, platform, event_ticker, series_ticker, title, url,
          category, end_date, is_active, last_synced_at, created_at, updated_at,
          1 - (embedding <=> ${vectorStr}::vector) AS similarity
        FROM markets
        WHERE is_active = true
          AND embedding IS NOT NULL
          AND 1 - (embedding <=> ${vectorStr}::vector) >= ${minSimilarity}
        ORDER BY embedding <=> ${vectorStr}::vector
        LIMIT ${this.config.topN}
      `;

      if (similarMarkets.length === 0) {
        results.set(newsItem.id, []);
        continue;
      }

      // Fetch contracts for matched markets
      const marketIds = similarMarkets.map((m) => m.id);
      const contracts = await this.prisma.contract.findMany({
        where: {
          marketId: { in: marketIds },
          isActive: true,
        },
      });

      // Group contracts by market ID
      const contractsByMarketId = new Map<number, PrismaContract[]>();
      for (const contract of contracts) {
        const existing = contractsByMarketId.get(contract.marketId) || [];
        existing.push(contract);
        contractsByMarketId.set(contract.marketId, existing);
      }

      // Convert to MatchedMarket format
      const matchedMarkets: MatchedMarket[] = similarMarkets.map((row) => {
        const market: PrismaMarketWithContracts = {
          id: row.id,
          platform: row.platform,
          eventTicker: row.event_ticker,
          seriesTicker: row.series_ticker,
          title: row.title,
          url: row.url,
          category: row.category,
          endDate: row.end_date,
          isActive: row.is_active,
          embeddingUpdatedAt: null,
          lastSyncedAt: row.last_synced_at,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          contracts: contractsByMarketId.get(row.id) || [],
        };

        const marketWithContracts = prismaMarketWithContractsToMarketWithContracts(market);
        return {
          market: marketWithContracts,
          contracts: marketWithContracts.contracts,
          similarity: row.similarity,
        };
      });

      results.set(newsItem.id, matchedMarkets);
    }

    this.logger.info('Batch matching complete', {
      newsItemCount: newsItems.length,
      totalMatches: Array.from(results.values()).reduce((sum, m) => sum + m.length, 0),
    });

    return results;
  }

  /**
   * Get text for embedding from a news item
   */
  private getNewsTextForEmbedding(newsItem: NewsItem): string {
    const parts = [newsItem.title];

    if (newsItem.content) {
      // Take first 1000 characters of content
      parts.push(newsItem.content.substring(0, 1000));
    }

    if (newsItem.tags && newsItem.tags.length > 0) {
      parts.push(`Topics: ${newsItem.tags.join(', ')}`);
    }

    return parts.join('. ');
  }

  /**
   * Format matched markets for inclusion in LLM prompt
   * Shows market question with all betting options
   */
  formatMarketsForPrompt(matchedMarkets: MatchedMarket[], maxMarkets: number = 20): string {
    const markets = matchedMarkets.slice(0, maxMarkets);
    const lines: string[] = [];

    for (let i = 0; i < markets.length; i++) {
      const match = markets[i];
      const market = match.market;
      const endInfo = market.endDate
        ? `Ends: ${new Date(market.endDate).toISOString().split('T')[0]}`
        : '';

      lines.push(
        `[${i + 1}] ${market.title} (${market.platform}) | Similarity: ${(match.similarity * 100).toFixed(1)}% | ${endInfo}`,
      );
      lines.push(`    URL: ${market.url}`);

      // Show contracts (betting options) with prices
      if (match.contracts.length > 0) {
        lines.push('    Options:');
        for (const contract of match.contracts.slice(0, 10)) {
          // Limit to 10 contracts per market
          const yesPercent = (contract.yesPrice * 100).toFixed(0);
          const noPercent = (contract.noPrice * 100).toFixed(0);
          lines.push(`      - ${contract.title}: Yes ${yesPercent}% / No ${noPercent}%`);
        }
        if (match.contracts.length > 10) {
          lines.push(`      ... and ${match.contracts.length - 10} more options`);
        }
      }

      lines.push(''); // Empty line between markets
    }

    return lines.join('\n');
  }

  /**
   * Get statistics about the matching service
   */
  async getStats(): Promise<{
    totalActiveMarkets: number;
    totalActiveContracts: number;
    marketsWithEmbeddings: number;
  }> {
    const totalActiveMarkets = await this.prisma.market.count({
      where: { isActive: true },
    });

    const totalActiveContracts = await this.prisma.contract.count({
      where: { isActive: true },
    });

    // Count markets that have embeddings (ready for matching)
    const marketsWithEmbeddings = await this.prisma.$queryRaw<[{ count: bigint }]>`
      SELECT COUNT(*) as count FROM markets
      WHERE is_active = true AND embedding IS NOT NULL
    `;

    return {
      totalActiveMarkets,
      totalActiveContracts,
      marketsWithEmbeddings: Number(marketsWithEmbeddings[0]?.count ?? 0),
    };
  }
}
