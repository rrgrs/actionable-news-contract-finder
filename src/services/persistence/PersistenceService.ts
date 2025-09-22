import 'reflect-metadata';
import { DataSource, Repository, LessThan, MoreThan } from 'typeorm';
import * as path from 'path';
import * as fs from 'fs';
import { ProcessedNews, ProcessedContract, Insight } from '../../entities';

export interface ProcessedNewsRecord {
  id: string;
  newsId: string;
  title: string;
  source: string;
  url: string;
  processedAt: Date;
  insightGenerated: boolean;
}

export interface ProcessedContractRecord {
  id: string;
  contractId: string;
  platform: string;
  newsId: string;
  validatedAt: Date;
  relevanceScore: number;
  action: string;
}

export class PersistenceService {
  private dataSource: DataSource;
  private newsRepository!: Repository<ProcessedNews>;
  private contractRepository!: Repository<ProcessedContract>;
  private insightRepository!: Repository<Insight>;
  private isInitialized = false;

  constructor(dbPath: string = './data/app.db') {
    // Ensure data directory exists
    const dataDir = path.dirname(dbPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Initialize TypeORM DataSource
    this.dataSource = new DataSource({
      type: 'sqlite',
      database: dbPath,
      entities: [ProcessedNews, ProcessedContract, Insight],
      synchronize: true, // Auto-create database schema
      logging: false, // Set to true for SQL query logging
    });
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      await this.dataSource.initialize();

      // Get repositories
      this.newsRepository = this.dataSource.getRepository(ProcessedNews);
      this.contractRepository = this.dataSource.getRepository(ProcessedContract);
      this.insightRepository = this.dataSource.getRepository(Insight);

      this.isInitialized = true;
      console.log('✅ Persistence service initialized with TypeORM');
    } catch (error) {
      console.error('Failed to initialize persistence service:', error);
      throw error;
    }
  }

  async isNewsProcessed(newsId: string): Promise<boolean> {
    const count = await this.newsRepository.count({
      where: { newsId },
    });
    return count > 0;
  }

  async markNewsAsProcessed(
    newsId: string,
    title: string,
    source: string,
    url?: string,
    insightGenerated: boolean = false,
  ): Promise<void> {
    // Check if already exists to avoid unique constraint violation
    const existing = await this.newsRepository.findOne({ where: { newsId } });
    if (existing) {
      return; // Already processed, skip
    }

    const news = this.newsRepository.create({
      newsId,
      title,
      source,
      url,
      insightGenerated,
      processedAt: new Date(),
    });

    await this.newsRepository.save(news);
  }

  async getProcessedNewsIds(since?: Date): Promise<Set<string>> {
    const whereClause = since ? { processedAt: MoreThan(since) } : {};

    const processedNews = await this.newsRepository.find({
      where: whereClause,
      select: ['newsId'],
    });

    return new Set(processedNews.map((news) => news.newsId));
  }

  async markContractAsValidated(
    contractId: string,
    platform: string,
    newsId: string,
    relevanceScore: number,
    action: string,
  ): Promise<void> {
    // Check if already exists to avoid unique constraint violation
    const existing = await this.contractRepository.findOne({
      where: { contractId, newsId },
    });
    if (existing) {
      return; // Already validated, skip
    }

    const contract = this.contractRepository.create({
      contractId,
      platform,
      newsId,
      relevanceScore,
      action,
      validatedAt: new Date(),
    });

    await this.contractRepository.save(contract);
  }

  async isContractValidatedForNews(contractId: string, newsId: string): Promise<boolean> {
    const count = await this.contractRepository.count({
      where: { contractId, newsId },
    });
    return count > 0;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async saveInsight(newsId: string, insightData: any, relevanceScore: number): Promise<void> {
    const insight = this.insightRepository.create({
      newsId,
      insightData: JSON.stringify(insightData),
      relevanceScore,
    });

    await this.insightRepository.save(insight);

    // Update the news record to mark insight as generated
    await this.newsRepository.update({ newsId }, { insightGenerated: true });
  }

  async getRecentStats(hours: number = 24): Promise<{
    newsProcessed: number;
    insightsGenerated: number;
    contractsValidated: number;
  }> {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const newsProcessed = await this.newsRepository.count({
      where: { processedAt: MoreThan(since) },
    });

    const insightsGenerated = await this.insightRepository.count({
      where: { createdAt: MoreThan(since) },
    });

    const contractsValidated = await this.contractRepository
      .createQueryBuilder('contract')
      .select('COUNT(DISTINCT contract.contractId)', 'count')
      .where('contract.validatedAt > :since', { since })
      .getRawOne();

    return {
      newsProcessed,
      insightsGenerated,
      contractsValidated: parseInt(contractsValidated?.count || '0'),
    };
  }

  async cleanup(daysToKeep: number = 7): Promise<void> {
    const cutoffDate = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);

    // Delete old insights first (due to foreign key constraints)
    await this.insightRepository.delete({
      createdAt: LessThan(cutoffDate),
    });

    // Delete old contracts
    await this.contractRepository.delete({
      validatedAt: LessThan(cutoffDate),
    });

    // Delete old processed news
    await this.newsRepository.delete({
      processedAt: LessThan(cutoffDate),
    });

    console.log(`🧹 Cleaned up records older than ${daysToKeep} days`);
  }

  async close(): Promise<void> {
    if (this.dataSource.isInitialized) {
      await this.dataSource.destroy();
      console.log('Database connection closed');
    }
  }
}
