import { PrismaClient, Market as PrismaMarket } from '@prisma/client';
import { BettingPlatform, Contract } from '../types';
import { EmbeddingService } from '../services/embedding/EmbeddingService';
import { BaseRunner, RunnerConfig } from './BaseRunner';
import {
  getTextForEmbedding,
  serializeMetadata,
  extractSeriesTicker,
  groupContractsByEvent,
  deriveMarketTitle,
} from '../lib/marketHelpers';

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

    // Fetch all contracts from the platform
    const contracts = await this.platform.getAvailableContracts();
    this.logger.debug('Fetched contracts', { count: contracts.length });

    // Group contracts by event ticker
    const contractGroups = groupContractsByEvent(contracts);
    this.logger.debug('Grouped contracts into markets', {
      marketCount: contractGroups.size,
    });

    // Track which markets and contracts we've seen
    const seenMarketTickers = new Set<string>();
    const seenContractTickers = new Set<string>();
    const marketsNeedingEmbeddings: PrismaMarket[] = [];

    // Process each market group
    for (const [eventTicker, groupContracts] of contractGroups) {
      seenMarketTickers.add(eventTicker);

      const marketResult = await this.syncMarket(eventTicker, groupContracts);

      if (marketResult.created) {
        stats.marketsAdded++;
        marketsNeedingEmbeddings.push(marketResult.market);
      } else if (marketResult.updated) {
        stats.marketsUpdated++;
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

    // Deactivate markets no longer in the platform
    stats.marketsDeactivated = await this.deactivateOldMarkets(seenMarketTickers);

    // Deactivate contracts no longer in the platform
    stats.contractsDeactivated = await this.deactivateOldContracts(seenContractTickers);

    // Generate embeddings for new/updated markets
    if (marketsNeedingEmbeddings.length > 0) {
      stats.embeddingsGenerated = await this.generateEmbeddings(marketsNeedingEmbeddings);
    }

    return stats;
  }

  private async syncMarket(
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

    const existingMarket = await this.prisma.market.findUnique({
      where: {
        platform_eventTicker: { platform: this.platform.name, eventTicker },
      },
    });

    if (existingMarket) {
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
            isActive: true,
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

      // Just update sync time and ensure active
      await this.prisma.market.update({
        where: { id: existingMarket.id },
        data: { lastSyncedAt: new Date(), isActive: true },
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
        platform: this.platform.name,
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

    const existingContract = await this.prisma.contract.findUnique({
      where: { contractTicker },
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
            metadata: serializeMetadata(metadata),
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

  private async deactivateOldMarkets(seenTickers: Set<string>): Promise<number> {
    const allActive = await this.prisma.market.findMany({
      where: { platform: this.platform.name, isActive: true },
      select: { id: true, eventTicker: true },
    });

    const toDeactivate = allActive.filter((m) => !seenTickers.has(m.eventTicker));

    if (toDeactivate.length > 0) {
      await this.prisma.market.updateMany({
        where: { id: { in: toDeactivate.map((m) => m.id) } },
        data: { isActive: false },
      });
    }

    return toDeactivate.length;
  }

  private async deactivateOldContracts(seenTickers: Set<string>): Promise<number> {
    const allActive = await this.prisma.contract.findMany({
      where: {
        market: { platform: this.platform.name },
        isActive: true,
      },
      select: { id: true, contractTicker: true },
    });

    const toDeactivate = allActive.filter((c) => !seenTickers.has(c.contractTicker));

    if (toDeactivate.length > 0) {
      await this.prisma.contract.updateMany({
        where: { id: { in: toDeactivate.map((c) => c.id) } },
        data: { isActive: false },
      });
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
