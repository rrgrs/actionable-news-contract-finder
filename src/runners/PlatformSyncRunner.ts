import { PrismaClient, Market as PrismaMarket } from '@prisma/client';
import { BettingPlatform, MarketWithContracts, Contract } from '../types';
import { EmbeddingService } from '../services/embedding/EmbeddingService';
import { BaseRunner, RunnerConfig } from './BaseRunner';
import { getTextForEmbedding } from '../lib/marketHelpers';

export interface PlatformSyncRunnerConfig extends RunnerConfig {
  /** The betting platform to sync */
  platform: BettingPlatform;
  /** Prisma client for database access */
  prisma: PrismaClient;
  /** Embedding service for generating market embeddings */
  embeddingService: EmbeddingService;
  /** Batch size for embedding generation */
  embeddingBatchSize?: number;
}

interface SyncStats {
  marketsAdded: number;
  marketsUpdated: number;
  marketsDeactivated: number;
  contractsAdded: number;
  contractsUpdated: number;
  contractsDeactivated: number;
  embeddingsGenerated: number;
}

/**
 * Continuously syncs markets and contracts from a single betting platform.
 * Each betting platform should have its own runner instance.
 */
export class PlatformSyncRunner extends BaseRunner {
  private platform: BettingPlatform;
  private prisma: PrismaClient;
  private embeddingService: EmbeddingService;
  private embeddingBatchSize: number;

  constructor(config: PlatformSyncRunnerConfig) {
    super({
      name: `PlatformRunner:${config.platform.name}`,
      minDelayMs: config.minDelayMs || 5000,
      maxDelayMs: config.maxDelayMs || 300000, // 5 minutes max
    });
    this.platform = config.platform;
    this.prisma = config.prisma;
    this.embeddingService = config.embeddingService;
    this.embeddingBatchSize = config.embeddingBatchSize || 50;
  }

  protected async runOnce(): Promise<boolean> {
    const startTime = Date.now();
    const stats = await this.syncPlatform();
    const duration = Date.now() - startTime;

    this.logger.info('Sync cycle complete', {
      ...stats,
      durationMs: duration,
    });

    // Always return true since we're syncing continuously
    // The natural API latency provides rate limiting
    return true;
  }

  private async syncPlatform(): Promise<SyncStats> {
    const stats: SyncStats = {
      marketsAdded: 0,
      marketsUpdated: 0,
      marketsDeactivated: 0,
      contractsAdded: 0,
      contractsUpdated: 0,
      contractsDeactivated: 0,
      embeddingsGenerated: 0,
    };

    // Fetch all markets with their contracts from the platform
    const markets = await this.platform.getMarkets();
    this.logger.debug('Fetched markets', { count: markets.length });

    // Track which markets and contracts we've seen
    const seenMarketIds = new Set<string>();
    const seenContractIds = new Set<string>();
    const marketsNeedingEmbeddings: PrismaMarket[] = [];

    // Process each market
    for (const market of markets) {
      seenMarketIds.add(market.id);

      const marketResult = await this.syncMarket(market);

      if (marketResult.created) {
        stats.marketsAdded++;
      } else if (marketResult.updated) {
        stats.marketsUpdated++;
      }

      // Queue embedding generation for markets that need it
      if (marketResult.needsEmbedding) {
        marketsNeedingEmbeddings.push(marketResult.dbMarket);
      }

      // Sync contracts for this market
      for (const contract of market.contracts) {
        seenContractIds.add(contract.id);

        const contractResult = await this.syncContract(marketResult.dbMarket.id, contract);

        if (contractResult.created) {
          stats.contractsAdded++;
        } else if (contractResult.updated) {
          stats.contractsUpdated++;
        }
      }
    }

    // Deactivate markets no longer in the platform
    stats.marketsDeactivated = await this.deactivateOldMarkets(seenMarketIds);

    // Deactivate contracts no longer in the platform
    stats.contractsDeactivated = await this.deactivateOldContracts(seenContractIds);

    // Generate embeddings for new/updated markets (limit per sync to avoid overwhelming)
    const maxEmbeddingsPerSync = 200;
    if (marketsNeedingEmbeddings.length > 0) {
      const toEmbed = marketsNeedingEmbeddings.slice(0, maxEmbeddingsPerSync);
      if (marketsNeedingEmbeddings.length > maxEmbeddingsPerSync) {
        this.logger.info('Limiting embedding generation', {
          total: marketsNeedingEmbeddings.length,
          processing: toEmbed.length,
          remaining: marketsNeedingEmbeddings.length - maxEmbeddingsPerSync,
        });
      }
      stats.embeddingsGenerated = await this.generateEmbeddings(toEmbed);
    }

    return stats;
  }

  /**
   * Sync a market from the platform to the database.
   * Market data comes directly from the platform - no deriving needed.
   */
  private async syncMarket(market: MarketWithContracts): Promise<{
    dbMarket: PrismaMarket;
    created: boolean;
    updated: boolean;
    needsEmbedding: boolean;
  }> {
    const existingMarket = await this.prisma.market.findUnique({
      where: {
        platform_eventTicker: { platform: market.platform, eventTicker: market.id },
      },
    });

    if (existingMarket) {
      // Check if market has embedding (Prisma doesn't support vector type directly)
      const embeddingCheck = await this.prisma.$queryRaw<Array<{ has_embedding: boolean }>>`
        SELECT embedding IS NOT NULL as has_embedding FROM markets WHERE id = ${existingMarket.id}
      `;
      const hasEmbedding = embeddingCheck[0]?.has_embedding ?? false;

      const needsUpdate =
        existingMarket.title !== market.title ||
        existingMarket.url !== market.url ||
        existingMarket.category !== market.category;

      if (needsUpdate) {
        const updatedMarket = await this.prisma.market.update({
          where: { id: existingMarket.id },
          data: {
            title: market.title,
            url: market.url,
            category: market.category,
            endDate: market.endDate,
            seriesTicker: market.seriesTicker,
            isActive: true,
            lastSyncedAt: new Date(),
          },
        });

        return {
          dbMarket: updatedMarket,
          created: false,
          updated: true,
          needsEmbedding: !hasEmbedding || existingMarket.title !== market.title,
        };
      }

      // Just update sync time and ensure active
      await this.prisma.market.update({
        where: { id: existingMarket.id },
        data: { lastSyncedAt: new Date(), isActive: true },
      });

      return {
        dbMarket: existingMarket,
        created: false,
        updated: false,
        needsEmbedding: !hasEmbedding,
      };
    }

    // Create new market
    const newMarket = await this.prisma.market.create({
      data: {
        platform: market.platform,
        eventTicker: market.id,
        seriesTicker: market.seriesTicker,
        title: market.title,
        url: market.url,
        category: market.category,
        endDate: market.endDate,
        isActive: true,
        lastSyncedAt: new Date(),
      },
    });

    return {
      dbMarket: newMarket,
      created: true,
      updated: false,
      needsEmbedding: true,
    };
  }

  /**
   * Sync a contract from the platform to the database.
   */
  private async syncContract(
    marketId: number,
    contract: Contract,
  ): Promise<{ created: boolean; updated: boolean }> {
    const existingContract = await this.prisma.contract.findUnique({
      where: { contractTicker: contract.id },
    });

    if (existingContract) {
      const needsUpdate =
        existingContract.yesPrice !== contract.yesPrice ||
        existingContract.noPrice !== contract.noPrice ||
        existingContract.volume !== contract.volume ||
        existingContract.liquidity !== contract.liquidity ||
        existingContract.title !== contract.title;

      if (needsUpdate) {
        await this.prisma.contract.update({
          where: { id: existingContract.id },
          data: {
            title: contract.title,
            yesPrice: contract.yesPrice,
            noPrice: contract.noPrice,
            volume: contract.volume,
            liquidity: contract.liquidity,
            isActive: true,
            lastSyncedAt: new Date(),
          },
        });

        return { created: false, updated: true };
      }

      // Just update sync time
      await this.prisma.contract.update({
        where: { id: existingContract.id },
        data: { lastSyncedAt: new Date(), isActive: true },
      });

      return { created: false, updated: false };
    }

    // Create new contract
    await this.prisma.contract.create({
      data: {
        marketId,
        contractTicker: contract.id,
        title: contract.title,
        yesPrice: contract.yesPrice,
        noPrice: contract.noPrice,
        volume: contract.volume,
        liquidity: contract.liquidity,
        isActive: true,
        lastSyncedAt: new Date(),
      },
    });

    return { created: true, updated: false };
  }

  private async deactivateOldMarkets(seenIds: Set<string>): Promise<number> {
    const allActive = await this.prisma.market.findMany({
      where: { platform: this.platform.name, isActive: true },
      select: { id: true, eventTicker: true },
    });

    const toDeactivate = allActive.filter((m) => !seenIds.has(m.eventTicker));

    if (toDeactivate.length > 0) {
      // Batch updates to avoid exceeding PostgreSQL's bind variable limit (32767)
      const batchSize = 10000;
      for (let i = 0; i < toDeactivate.length; i += batchSize) {
        const batch = toDeactivate.slice(i, i + batchSize);
        await this.prisma.market.updateMany({
          where: { id: { in: batch.map((m) => m.id) } },
          data: { isActive: false },
        });
      }
    }

    return toDeactivate.length;
  }

  private async deactivateOldContracts(seenIds: Set<string>): Promise<number> {
    const allActive = await this.prisma.contract.findMany({
      where: {
        market: { platform: this.platform.name },
        isActive: true,
      },
      select: { id: true, contractTicker: true },
    });

    const toDeactivate = allActive.filter((c) => !seenIds.has(c.contractTicker));

    if (toDeactivate.length > 0) {
      // Batch updates to avoid exceeding PostgreSQL's bind variable limit (32767)
      const batchSize = 10000;
      for (let i = 0; i < toDeactivate.length; i += batchSize) {
        const batch = toDeactivate.slice(i, i + batchSize);
        await this.prisma.contract.updateMany({
          where: { id: { in: batch.map((c) => c.id) } },
          data: { isActive: false },
        });
      }
    }

    return toDeactivate.length;
  }

  private async generateEmbeddings(markets: PrismaMarket[]): Promise<number> {
    let generated = 0;

    for (let i = 0; i < markets.length; i += this.embeddingBatchSize) {
      const batch = markets.slice(i, i + this.embeddingBatchSize);
      const texts = batch.map((market) => getTextForEmbedding(market));

      try {
        const embeddings = await this.embeddingService.generateEmbeddings(texts);

        for (let j = 0; j < batch.length; j++) {
          if (embeddings[j] && embeddings[j].length > 0) {
            const vectorStr = `[${embeddings[j].join(',')}]`;
            await this.prisma.$executeRaw`
              UPDATE markets
              SET embedding = ${vectorStr}::vector,
                  embedding_updated_at = NOW()
              WHERE id = ${batch[j].id}
            `;
            generated++;
          }
        }
      } catch (error) {
        this.logger.error('Failed to generate embeddings for batch', {
          batchStart: i,
          batchSize: batch.length,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return generated;
  }

  protected async onStart(): Promise<void> {
    this.logger.info('Initializing platform sync', {
      platform: this.platform.name,
    });
  }

  protected async onStop(): Promise<void> {
    this.logger.info('Platform sync runner stopped', {
      platform: this.platform.name,
    });
  }
}
