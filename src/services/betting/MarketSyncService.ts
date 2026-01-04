import { PrismaClient, Market as PrismaMarket, Contract as PrismaContract } from '@prisma/client';
import { BettingPlatform, Contract } from '../../types';
import { EmbeddingService } from '../embedding/EmbeddingService';
import { createLogger } from '../../utils/logger';
import {
  getTextForEmbedding,
  serializeMetadata,
  extractSeriesTicker,
  groupContractsByEvent,
  deriveMarketTitle,
} from '../../lib/marketHelpers';

export interface MarketSyncConfig {
  syncIntervalMs: number;
  embeddingBatchSize: number;
}

export interface SyncStats {
  platformsSynced: number;
  marketsAdded: number;
  marketsUpdated: number;
  marketsDeactivated: number;
  contractsAdded: number;
  contractsUpdated: number;
  contractsDeactivated: number;
  embeddingsGenerated: number;
  errors: string[];
}

/**
 * Service that periodically syncs markets and contracts from betting platforms.
 * Groups incoming flat contracts into Market + Contract hierarchy.
 * Generates embeddings at the Market level for semantic matching.
 */
export class MarketSyncService {
  private syncInterval: NodeJS.Timeout | null = null;
  private isRunning = false;
  private logger = createLogger('MarketSyncService');

  constructor(
    private prisma: PrismaClient,
    private bettingPlatforms: BettingPlatform[],
    private embeddingService: EmbeddingService,
    private config: MarketSyncConfig,
  ) {}

  async initialize(): Promise<void> {
    this.logger.info('MarketSyncService initialized', {
      platforms: this.bettingPlatforms.map((p) => p.name),
      syncIntervalMs: this.config.syncIntervalMs,
    });
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('MarketSyncService is already running');
      return;
    }

    this.isRunning = true;

    // Run initial sync
    this.logger.info('Starting initial market sync...');
    await this.syncAllPlatforms();

    // Set up recurring sync
    this.syncInterval = setInterval(async () => {
      try {
        await this.syncAllPlatforms();
      } catch (error) {
        this.logger.error('Error in sync loop', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, this.config.syncIntervalMs);

    this.logger.info('MarketSyncService started', {
      syncIntervalMinutes: this.config.syncIntervalMs / 60000,
    });
  }

  async stop(): Promise<void> {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    this.isRunning = false;
    this.logger.info('MarketSyncService stopped');
  }

  async syncAllPlatforms(): Promise<SyncStats> {
    const stats: SyncStats = {
      platformsSynced: 0,
      marketsAdded: 0,
      marketsUpdated: 0,
      marketsDeactivated: 0,
      contractsAdded: 0,
      contractsUpdated: 0,
      contractsDeactivated: 0,
      embeddingsGenerated: 0,
      errors: [],
    };

    for (const platform of this.bettingPlatforms) {
      try {
        const platformStats = await this.syncPlatform(platform);
        stats.platformsSynced++;
        stats.marketsAdded += platformStats.marketsAdded;
        stats.marketsUpdated += platformStats.marketsUpdated;
        stats.marketsDeactivated += platformStats.marketsDeactivated;
        stats.contractsAdded += platformStats.contractsAdded;
        stats.contractsUpdated += platformStats.contractsUpdated;
        stats.contractsDeactivated += platformStats.contractsDeactivated;
        stats.embeddingsGenerated += platformStats.embeddingsGenerated;
        stats.errors.push(...platformStats.errors);
      } catch (error) {
        const errorMessage = `Failed to sync ${platform.name}: ${error instanceof Error ? error.message : String(error)}`;
        this.logger.error(errorMessage);
        stats.errors.push(errorMessage);
      }
    }

    this.logger.info('Sync cycle complete', {
      ...stats,
      errorCount: stats.errors.length,
    });

    return stats;
  }

  private async syncPlatform(platform: BettingPlatform): Promise<SyncStats> {
    const stats: SyncStats = {
      platformsSynced: 1,
      marketsAdded: 0,
      marketsUpdated: 0,
      marketsDeactivated: 0,
      contractsAdded: 0,
      contractsUpdated: 0,
      contractsDeactivated: 0,
      embeddingsGenerated: 0,
      errors: [],
    };

    this.logger.debug('Syncing platform', { platform: platform.name });

    // Fetch all contracts from the platform
    const contracts = await platform.getAvailableContracts();
    this.logger.debug('Fetched contracts', {
      platform: platform.name,
      count: contracts.length,
    });

    // Group contracts by event ticker
    const contractGroups = groupContractsByEvent(contracts);
    this.logger.debug('Grouped contracts into markets', {
      platform: platform.name,
      marketCount: contractGroups.size,
    });

    // Track which markets and contracts we've seen in this sync
    const seenMarketTickers = new Set<string>();
    const seenContractTickers = new Set<string>();
    const marketsNeedingEmbeddings: PrismaMarket[] = [];

    // Process each market group
    for (const [eventTicker, groupContracts] of contractGroups) {
      seenMarketTickers.add(eventTicker);

      // Create or update market
      const marketResult = await this.syncMarket(platform.name, eventTicker, groupContracts);

      if (marketResult.created) {
        stats.marketsAdded++;
        marketsNeedingEmbeddings.push(marketResult.market);
      } else if (marketResult.updated) {
        stats.marketsUpdated++;
        // If title changed, need new embedding
        if (marketResult.titleChanged) {
          marketsNeedingEmbeddings.push(marketResult.market);
        }
      }

      // Sync contracts for this market
      for (const contract of groupContracts) {
        seenContractTickers.add(contract.id);

        const contractResult = await this.syncContract(marketResult.market.id, contract);

        if (contractResult.created) {
          stats.contractsAdded++;
        } else if (contractResult.updated) {
          stats.contractsUpdated++;
        }
      }
    }

    // Deactivate markets that are no longer in the platform
    // Use a different approach to avoid SQLite parameter limits with large notIn queries
    const allActiveMarkets = await this.prisma.market.findMany({
      where: {
        platform: platform.name,
        isActive: true,
      },
      select: { id: true, eventTicker: true },
    });

    const marketsToDeactivate = allActiveMarkets.filter(
      (m) => !seenMarketTickers.has(m.eventTicker),
    );

    if (marketsToDeactivate.length > 0) {
      // Batch updates to avoid PostgreSQL bind variable limit (32767)
      const marketIds = marketsToDeactivate.map((m) => m.id);
      await this.batchUpdateMany('market', marketIds, { isActive: false });
      stats.marketsDeactivated = marketsToDeactivate.length;
    }

    // Deactivate contracts that are no longer in the platform
    // Get contracts via their markets since Contract no longer has platform column
    const allActiveContracts = await this.prisma.contract.findMany({
      where: {
        market: { platform: platform.name },
        isActive: true,
      },
      select: { id: true, contractTicker: true },
    });

    const contractsToDeactivate = allActiveContracts.filter(
      (c) => !seenContractTickers.has(c.contractTicker),
    );

    if (contractsToDeactivate.length > 0) {
      // Batch updates to avoid PostgreSQL bind variable limit (32767)
      const contractIds = contractsToDeactivate.map((c) => c.id);
      await this.batchUpdateMany('contract', contractIds, { isActive: false });
      stats.contractsDeactivated = contractsToDeactivate.length;
    }

    // Generate embeddings for new/updated markets
    if (marketsNeedingEmbeddings.length > 0) {
      stats.embeddingsGenerated = await this.generateEmbeddingsForMarkets(marketsNeedingEmbeddings);
    }

    this.logger.debug('Platform sync complete', {
      platform: platform.name,
      marketsAdded: stats.marketsAdded,
      marketsUpdated: stats.marketsUpdated,
      marketsDeactivated: stats.marketsDeactivated,
      contractsAdded: stats.contractsAdded,
      contractsUpdated: stats.contractsUpdated,
      contractsDeactivated: stats.contractsDeactivated,
      embeddingsGenerated: stats.embeddingsGenerated,
    });

    return stats;
  }

  private async syncMarket(
    platform: string,
    eventTicker: string,
    contracts: Contract[],
  ): Promise<{
    market: PrismaMarket;
    created: boolean;
    updated: boolean;
    titleChanged: boolean;
  }> {
    const firstContract = contracts[0];
    const metadata = firstContract.metadata || {};

    const seriesTicker = (metadata.seriesTicker as string) || extractSeriesTicker(eventTicker);
    const title = deriveMarketTitle(contracts);
    const url = firstContract.url;
    const category = (metadata.category as string) || (firstContract.tags?.[0] as string);
    const endDate = firstContract.endDate;

    // Check if market exists
    const existingMarket = await this.prisma.market.findUnique({
      where: {
        platform_eventTicker: { platform, eventTicker },
      },
    });

    if (existingMarket) {
      // Check if we need to update
      const needsUpdate =
        existingMarket.title !== title ||
        existingMarket.url !== url ||
        existingMarket.category !== category;

      if (needsUpdate) {
        const updatedMarket = await this.prisma.market.update({
          where: { id: existingMarket.id },
          data: {
            title,
            url,
            category,
            endDate,
            lastSyncedAt: new Date(),
          },
        });

        return {
          market: updatedMarket,
          created: false,
          updated: true,
          titleChanged: existingMarket.title !== title,
        };
      }

      // Just update sync time
      await this.prisma.market.update({
        where: { id: existingMarket.id },
        data: { lastSyncedAt: new Date() },
      });

      return {
        market: existingMarket,
        created: false,
        updated: false,
        titleChanged: false,
      };
    }

    // Create new market
    const newMarket = await this.prisma.market.create({
      data: {
        platform,
        eventTicker,
        seriesTicker,
        title,
        url,
        category,
        endDate,
        isActive: true,
        lastSyncedAt: new Date(),
      },
    });

    return {
      market: newMarket,
      created: true,
      updated: false,
      titleChanged: false,
    };
  }

  private async syncContract(
    marketId: number,
    contract: Contract,
  ): Promise<{ created: boolean; updated: boolean }> {
    const contractTicker = contract.id;
    const metadata = contract.metadata || {};

    // Check if contract exists (contractTicker is now unique across all platforms)
    const existingContract = await this.prisma.contract.findUnique({
      where: { contractTicker },
    });

    if (existingContract) {
      // Check if we need to update pricing
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
            metadata: serializeMetadata(metadata),
            lastSyncedAt: new Date(),
          },
        });

        return { created: false, updated: true };
      }

      // Just update sync time
      await this.prisma.contract.update({
        where: { id: existingContract.id },
        data: { lastSyncedAt: new Date() },
      });

      return { created: false, updated: false };
    }

    // Create new contract (platform is inherited from parent Market)
    await this.prisma.contract.create({
      data: {
        marketId,
        contractTicker,
        title: contract.title,
        yesPrice: contract.yesPrice,
        noPrice: contract.noPrice,
        volume: contract.volume,
        liquidity: contract.liquidity,
        metadata: serializeMetadata(metadata),
        isActive: true,
        lastSyncedAt: new Date(),
      },
    });

    return { created: true, updated: false };
  }

  private async generateEmbeddingsForMarkets(markets: PrismaMarket[]): Promise<number> {
    let generated = 0;

    // Process in batches
    for (let i = 0; i < markets.length; i += this.config.embeddingBatchSize) {
      const batch = markets.slice(i, i + this.config.embeddingBatchSize);
      const texts = batch.map((market) => getTextForEmbedding(market));

      try {
        const embeddings = await this.embeddingService.generateEmbeddings(texts);

        for (let j = 0; j < batch.length; j++) {
          if (embeddings[j] && embeddings[j].length > 0) {
            // Use raw SQL to store vector in PostgreSQL pgvector format
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

  /**
   * Get all active markets with their contracts
   */
  async getActiveMarkets(): Promise<(PrismaMarket & { contracts: PrismaContract[] })[]> {
    return this.prisma.market.findMany({
      where: { isActive: true },
      include: { contracts: { where: { isActive: true } } },
    });
  }

  /**
   * Get active markets with embeddings
   */
  async getActiveMarketsWithEmbeddings(): Promise<PrismaMarket[]> {
    // Use raw query since embedding is an Unsupported type
    const marketIds = await this.prisma.$queryRaw<{ id: number }[]>`
      SELECT id FROM markets
      WHERE is_active = true AND embedding IS NOT NULL
    `;

    if (marketIds.length === 0) {
      return [];
    }

    return this.prisma.market.findMany({
      where: {
        id: { in: marketIds.map((m) => m.id) },
      },
    });
  }

  /**
   * Get markets by platform
   */
  async getMarketsByPlatform(
    platform: string,
  ): Promise<(PrismaMarket & { contracts: PrismaContract[] })[]> {
    return this.prisma.market.findMany({
      where: { platform, isActive: true },
      include: { contracts: { where: { isActive: true } } },
    });
  }

  /**
   * Get sync statistics
   */
  async getSyncStats(): Promise<{
    totalActiveMarkets: number;
    totalActiveContracts: number;
    marketsWithEmbeddings: number;
    marketsByPlatform: Record<string, number>;
    oldestSync: Date | null;
    newestSync: Date | null;
  }> {
    const activeMarkets = await this.prisma.market.findMany({
      where: { isActive: true },
    });

    const activeContracts = await this.prisma.contract.count({
      where: { isActive: true },
    });

    // Count markets with embeddings using raw query
    const embeddingCount = await this.prisma.$queryRaw<[{ count: bigint }]>`
      SELECT COUNT(*) as count FROM markets
      WHERE is_active = true AND embedding IS NOT NULL
    `;
    const marketsWithEmbeddings = Number(embeddingCount[0]?.count ?? 0);

    const marketsByPlatform: Record<string, number> = {};
    let oldestSync: Date | null = null;
    let newestSync: Date | null = null;

    for (const market of activeMarkets) {
      marketsByPlatform[market.platform] = (marketsByPlatform[market.platform] || 0) + 1;

      if (!oldestSync || market.lastSyncedAt < oldestSync) {
        oldestSync = market.lastSyncedAt;
      }
      if (!newestSync || market.lastSyncedAt > newestSync) {
        newestSync = market.lastSyncedAt;
      }
    }

    return {
      totalActiveMarkets: activeMarkets.length,
      totalActiveContracts: activeContracts,
      marketsWithEmbeddings,
      marketsByPlatform,
      oldestSync,
      newestSync,
    };
  }

  /**
   * Force regenerate embeddings for all markets
   */
  async regenerateAllEmbeddings(): Promise<number> {
    const markets = await this.prisma.market.findMany({
      where: { isActive: true },
    });

    this.logger.info('Regenerating embeddings for all markets', {
      count: markets.length,
    });

    return this.generateEmbeddingsForMarkets(markets);
  }

  /**
   * Batch updateMany to avoid PostgreSQL bind variable limit (32767)
   */
  private async batchUpdateMany(
    table: 'market' | 'contract',
    ids: number[],
    data: { isActive: boolean },
  ): Promise<void> {
    const BATCH_SIZE = 10000; // Well under the 32767 limit

    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);

      if (table === 'market') {
        await this.prisma.market.updateMany({
          where: { id: { in: batch } },
          data,
        });
      } else {
        await this.prisma.contract.updateMany({
          where: { id: { in: batch } },
          data,
        });
      }
    }
  }
}
