import 'reflect-metadata';
import { PersistenceService } from '../PersistenceService';
import * as fs from 'fs';
import * as path from 'path';

describe('PersistenceService', () => {
  let persistenceService: PersistenceService;
  const testDbPath = './test-data/test.db';

  beforeEach(() => {
    // Clean up any existing test database
    const testDir = path.dirname(testDbPath);
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }

    persistenceService = new PersistenceService(testDbPath);
  });

  afterEach(async () => {
    // Close the database connection
    if (persistenceService) {
      await persistenceService.close();
    }

    // Clean up test database
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }

    // Remove test directory if empty
    const testDir = path.dirname(testDbPath);
    if (fs.existsSync(testDir)) {
      const files = fs.readdirSync(testDir);
      if (files.length === 0) {
        fs.rmdirSync(testDir);
      }
    }
  });

  describe('initialize', () => {
    it('should initialize the database successfully', async () => {
      await expect(persistenceService.initialize()).resolves.not.toThrow();

      // Verify database file was created
      expect(fs.existsSync(testDbPath)).toBe(true);
    });

    it('should be idempotent when called multiple times', async () => {
      await persistenceService.initialize();
      await expect(persistenceService.initialize()).resolves.not.toThrow();
    });
  });

  describe('news processing', () => {
    beforeEach(async () => {
      await persistenceService.initialize();
    });

    it('should mark news as processed', async () => {
      const newsId = 'news-123';
      const title = 'Test News';
      const source = 'TestSource';
      const url = 'https://example.com/news';

      await persistenceService.markNewsAsProcessed(newsId, title, source, url, false);

      const isProcessed = await persistenceService.isNewsProcessed(newsId);
      expect(isProcessed).toBe(true);
    });

    it('should return false for unprocessed news', async () => {
      const isProcessed = await persistenceService.isNewsProcessed('unknown-id');
      expect(isProcessed).toBe(false);
    });

    it('should handle duplicate news IDs gracefully', async () => {
      const newsId = 'news-456';
      const title = 'Test News';
      const source = 'TestSource';

      await persistenceService.markNewsAsProcessed(newsId, title, source);

      // Try to mark the same news as processed again - should not throw
      await expect(
        persistenceService.markNewsAsProcessed(newsId, 'Different Title', 'Different Source'),
      ).resolves.not.toThrow();
    });

    it('should retrieve processed news IDs', async () => {
      await persistenceService.markNewsAsProcessed('news-1', 'Title 1', 'Source 1');
      await persistenceService.markNewsAsProcessed('news-2', 'Title 2', 'Source 2');
      await persistenceService.markNewsAsProcessed('news-3', 'Title 3', 'Source 3');

      const processedIds = await persistenceService.getProcessedNewsIds();

      expect(processedIds).toBeInstanceOf(Set);
      expect(processedIds.size).toBe(3);
      expect(processedIds.has('news-1')).toBe(true);
      expect(processedIds.has('news-2')).toBe(true);
      expect(processedIds.has('news-3')).toBe(true);
    });

    it('should filter processed news by date', async () => {
      await persistenceService.markNewsAsProcessed('news-old', 'Old News', 'Source');

      // Wait a bit and then add new news
      await new Promise((resolve) => setTimeout(resolve, 100));
      const afterDate = new Date();
      await new Promise((resolve) => setTimeout(resolve, 100));

      await persistenceService.markNewsAsProcessed('news-new', 'New News', 'Source');

      const recentIds = await persistenceService.getProcessedNewsIds(afterDate);

      expect(recentIds.size).toBe(1);
      expect(recentIds.has('news-new')).toBe(true);
      expect(recentIds.has('news-old')).toBe(false);
    });
  });

  describe('contract validation', () => {
    beforeEach(async () => {
      await persistenceService.initialize();
    });

    it('should mark contract as validated', async () => {
      const contractId = 'contract-123';
      const platform = 'TestPlatform';
      const newsId = 'news-123';
      const relevanceScore = 0.85;
      const action = 'BUY';

      // First create the news item (required for foreign key)
      await persistenceService.markNewsAsProcessed(newsId, 'Test News', 'TestSource');

      await persistenceService.markContractAsValidated(
        contractId,
        platform,
        newsId,
        relevanceScore,
        action,
      );

      const isValidated = await persistenceService.isContractValidatedForNews(contractId, newsId);
      expect(isValidated).toBe(true);
    });

    it('should return false for unvalidated contract-news pairs', async () => {
      const isValidated = await persistenceService.isContractValidatedForNews(
        'unknown',
        'news-123',
      );
      expect(isValidated).toBe(false);
    });

    it('should handle duplicate contract-news pairs', async () => {
      const contractId = 'contract-456';
      const newsId = 'news-456';

      // First create the news item (required for foreign key)
      await persistenceService.markNewsAsProcessed(newsId, 'Test News', 'TestSource');

      await persistenceService.markContractAsValidated(contractId, 'Platform', newsId, 0.8, 'HOLD');

      // Try to validate again - should not throw due to unique constraint
      await expect(
        persistenceService.markContractAsValidated(contractId, 'Platform', newsId, 0.9, 'SELL'),
      ).resolves.not.toThrow();
    });
  });

  describe('insights', () => {
    beforeEach(async () => {
      await persistenceService.initialize();
    });

    it('should save insights', async () => {
      const newsId = 'news-789';
      const insightData = {
        summary: 'Test insight',
        predictions: ['prediction1', 'prediction2'],
      };
      const relevanceScore = 0.75;

      // First mark the news as processed (required for foreign key)
      await persistenceService.markNewsAsProcessed(newsId, 'Title', 'Source');

      await expect(
        persistenceService.saveInsight(newsId, insightData, relevanceScore),
      ).resolves.not.toThrow();
    });

    it('should update news as having insight generated', async () => {
      const newsId = 'news-insight';

      // Mark news as processed without insight
      await persistenceService.markNewsAsProcessed(newsId, 'Title', 'Source', undefined, false);

      // Save an insight
      await persistenceService.saveInsight(newsId, { data: 'test' }, 0.8);

      // Check if the news is marked as having insight
      // We'll need to verify this through stats or by checking the database
      const stats = await persistenceService.getRecentStats(24);
      expect(stats.insightsGenerated).toBeGreaterThanOrEqual(1);
    });
  });

  describe('statistics', () => {
    beforeEach(async () => {
      await persistenceService.initialize();
    });

    it('should return recent statistics', async () => {
      // Add some test data
      await persistenceService.markNewsAsProcessed('news-stat-1', 'Title 1', 'Source');
      await persistenceService.markNewsAsProcessed('news-stat-2', 'Title 2', 'Source');
      await persistenceService.saveInsight('news-stat-1', { test: true }, 0.9);
      await persistenceService.markContractAsValidated(
        'contract-1',
        'Platform',
        'news-stat-1',
        0.8,
        'BUY',
      );

      const stats = await persistenceService.getRecentStats(24);

      expect(stats).toEqual({
        newsProcessed: 2,
        insightsGenerated: 1,
        contractsValidated: 1,
      });
    });

    it('should filter statistics by time window', async () => {
      // Add some data
      await persistenceService.markNewsAsProcessed('news-recent', 'Recent', 'Source');

      // Get stats for a very small time window (0.001 hours = 3.6 seconds)
      await new Promise((resolve) => setTimeout(resolve, 4000)); // Wait 4 seconds

      const stats = await persistenceService.getRecentStats(0.001);

      expect(stats.newsProcessed).toBe(0);
    });
  });

  describe('cleanup', () => {
    beforeEach(async () => {
      await persistenceService.initialize();
    });

    it('should clean up old records', async () => {
      // Add some records
      await persistenceService.markNewsAsProcessed('news-to-clean', 'Old News', 'Source');
      await persistenceService.markContractAsValidated(
        'contract-old',
        'Platform',
        'news-to-clean',
        0.7,
        'SELL',
      );

      // Clean up with 0 days to keep (should delete everything)
      await persistenceService.cleanup(0);

      // Check that records were deleted
      const processedIds = await persistenceService.getProcessedNewsIds();
      expect(processedIds.size).toBe(0);
    });

    it('should preserve recent records during cleanup', async () => {
      // Add a record
      await persistenceService.markNewsAsProcessed('news-keep', 'Keep This', 'Source');

      // Clean up with 7 days to keep (default)
      await persistenceService.cleanup(7);

      // Recent record should still exist
      const isProcessed = await persistenceService.isNewsProcessed('news-keep');
      expect(isProcessed).toBe(true);
    });
  });

  describe('database lifecycle', () => {
    it('should handle close gracefully', async () => {
      await persistenceService.initialize();
      await expect(persistenceService.close()).resolves.not.toThrow();
    });

    it('should handle close when not initialized', async () => {
      await expect(persistenceService.close()).resolves.not.toThrow();
    });
  });
});
