import * as path from 'path';
import * as fs from 'fs';
import { PrismaClient } from '@prisma/client';
import prisma from '../../lib/prisma';

export interface ContractMatch {
  contractTicker: string;
  similarity?: number;
  relevanceScore: number;
  confidence: number;
  suggestedPosition: 'buy' | 'sell' | 'hold';
  reasoning?: string;
}

export class PersistenceService {
  private prisma: PrismaClient;
  private isInitialized = false;

  constructor(dbPath: string = './data/app.db') {
    // Ensure data directory exists
    const dataDir = path.dirname(dbPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Use shared Prisma client
    this.prisma = prisma;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      // Test connection by running a simple query
      await this.prisma.$connect();
      this.isInitialized = true;
      console.log('✅ Persistence service initialized with Prisma');
    } catch (error) {
      console.error('Failed to initialize persistence service:', error);
      throw error;
    }
  }

  async isNewsProcessed(newsId: string): Promise<boolean> {
    const count = await this.prisma.processedNews.count({
      where: { newsId },
    });
    return count > 0;
  }

  /**
   * Mark a news item as processed with optional title and content
   */
  async markNewsAsProcessed(
    newsId: string,
    options?: {
      title?: string;
      content?: string;
    },
  ): Promise<void> {
    await this.prisma.processedNews.upsert({
      where: { newsId },
      update: {
        title: options?.title,
        content: options?.content,
      },
      create: {
        newsId,
        title: options?.title,
        content: options?.content,
        processedAt: new Date(),
      },
    });
  }

  /**
   * Save LLM-validated contract matches for a news item
   * Only saves contracts that the LLM determined are relevant
   */
  async saveContractMatches(newsId: string, matches: ContractMatch[]): Promise<number> {
    if (matches.length === 0) {
      return 0;
    }

    // Get or create the ProcessedNews record
    let processedNews = await this.prisma.processedNews.findUnique({
      where: { newsId },
    });

    if (!processedNews) {
      processedNews = await this.prisma.processedNews.create({
        data: {
          newsId,
          processedAt: new Date(),
        },
      });
    }

    // Look up contract IDs by ticker
    const contractTickers = matches.map((m) => m.contractTicker);
    const contracts = await this.prisma.contract.findMany({
      where: { contractTicker: { in: contractTickers } },
      select: { id: true, contractTicker: true },
    });

    const tickerToId = new Map(contracts.map((c) => [c.contractTicker, c.id]));

    // Filter matches to only those with valid contract IDs
    const validMatches = matches.filter((m) => tickerToId.has(m.contractTicker));

    if (validMatches.length === 0) {
      return 0;
    }

    // Delete existing matches for this news item and recreate
    await this.prisma.processedNewsContract.deleteMany({
      where: { processedNewsId: processedNews.id },
    });

    await this.prisma.processedNewsContract.createMany({
      data: validMatches.map((match) => ({
        processedNewsId: processedNews!.id,
        contractId: tickerToId.get(match.contractTicker)!,
        similarity: match.similarity,
        relevanceScore: match.relevanceScore,
        confidence: match.confidence,
        suggestedPosition: match.suggestedPosition,
        reasoning: match.reasoning,
      })),
    });

    return validMatches.length;
  }

  /**
   * Get contract matches for a news item
   */
  async getContractMatches(newsId: string): Promise<
    Array<{
      contractTicker: string;
      contractTitle: string;
      marketTitle: string;
      similarity: number | null;
      relevanceScore: number;
      confidence: number;
      suggestedPosition: string;
      reasoning: string | null;
    }>
  > {
    const matches = await this.prisma.processedNewsContract.findMany({
      where: {
        processedNews: { newsId },
      },
      include: {
        contract: {
          include: {
            market: true,
          },
        },
      },
    });

    return matches.map((match) => ({
      contractTicker: match.contract.contractTicker,
      contractTitle: match.contract.title,
      marketTitle: match.contract.market.title,
      similarity: match.similarity,
      relevanceScore: match.relevanceScore,
      confidence: match.confidence,
      suggestedPosition: match.suggestedPosition,
      reasoning: match.reasoning,
    }));
  }

  async getProcessedNewsIds(since?: Date): Promise<Set<string>> {
    const processedNews = await this.prisma.processedNews.findMany({
      where: since ? { processedAt: { gt: since } } : undefined,
      select: { newsId: true },
    });

    return new Set(processedNews.map((news) => news.newsId));
  }

  async getRecentStats(hours: number = 24): Promise<{
    newsProcessed: number;
    contractsMatched: number;
  }> {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const newsProcessed = await this.prisma.processedNews.count({
      where: { processedAt: { gt: since } },
    });

    const contractsMatched = await this.prisma.processedNewsContract.count({
      where: { createdAt: { gt: since } },
    });

    return {
      newsProcessed,
      contractsMatched,
    };
  }

  async cleanup(daysToKeep: number = 7): Promise<void> {
    const cutoffDate = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);

    // Delete old processed news (cascades to ProcessedNewsContract via FK)
    await this.prisma.processedNews.deleteMany({
      where: { processedAt: { lt: cutoffDate } },
    });

    console.log(`🧹 Cleaned up records older than ${daysToKeep} days`);
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
    console.log('Database connection closed');
  }

  /**
   * Get the Prisma client for direct access by other services
   */
  getPrismaClient(): PrismaClient {
    if (!this.isInitialized) {
      throw new Error('PersistenceService not initialized. Call initialize() first.');
    }
    return this.prisma;
  }
}
