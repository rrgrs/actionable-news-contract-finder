import { PersistenceService, ContractMatch } from '../PersistenceService';
import prisma from '../../../lib/prisma';

describe('PersistenceService', () => {
  let persistenceService: PersistenceService;
  let testMarketId: number;
  let testContractTicker: string;

  beforeEach(async () => {
    // Clean up all data before each test
    await prisma.processedNewsContract.deleteMany();
    await prisma.processedNews.deleteMany();

    // Create a test market and contract for relation tests
    const testMarket = await prisma.market.upsert({
      where: { platform_eventTicker: { platform: 'test', eventTicker: 'TEST-MARKET' } },
      update: {},
      create: {
        platform: 'test',
        eventTicker: 'TEST-MARKET',
        title: 'Test Market',
        url: 'https://example.com/test',
      },
    });
    testMarketId = testMarket.id;

    // Create a test contract
    const testContract = await prisma.contract.upsert({
      where: { contractTicker: 'TEST-CONTRACT-1' },
      update: {},
      create: {
        marketId: testMarketId,
        contractTicker: 'TEST-CONTRACT-1',
        title: 'Test Contract Option',
        yesPrice: 0.5,
        noPrice: 0.5,
      },
    });
    testContractTicker = testContract.contractTicker;

    persistenceService = new PersistenceService();
    await persistenceService.initialize();
  });

  afterAll(async () => {
    // Final cleanup and disconnect
    await prisma.processedNewsContract.deleteMany();
    await prisma.processedNews.deleteMany();
    await prisma.contract.deleteMany({ where: { market: { platform: 'test' } } });
    await prisma.market.deleteMany({ where: { platform: 'test' } });
    await prisma.$disconnect();
  });

  describe('initialize', () => {
    it('should initialize the database successfully', async () => {
      const newService = new PersistenceService();
      await expect(newService.initialize()).resolves.not.toThrow();
    });

    it('should be idempotent when called multiple times', async () => {
      await persistenceService.initialize();
      await expect(persistenceService.initialize()).resolves.not.toThrow();
    });
  });

  describe('news processing', () => {
    it('should mark news as processed', async () => {
      const newsId = 'news-123';

      await persistenceService.markNewsAsProcessed(newsId);

      const isProcessed = await persistenceService.isNewsProcessed(newsId);
      expect(isProcessed).toBe(true);
    });

    it('should return false for unprocessed news', async () => {
      const isProcessed = await persistenceService.isNewsProcessed('unknown-id');
      expect(isProcessed).toBe(false);
    });

    it('should handle duplicate news IDs gracefully', async () => {
      const newsId = 'news-456';

      await persistenceService.markNewsAsProcessed(newsId);

      // Try to mark the same news as processed again - should not throw
      await expect(persistenceService.markNewsAsProcessed(newsId)).resolves.not.toThrow();
    });

    it('should retrieve processed news IDs', async () => {
      await persistenceService.markNewsAsProcessed('news-1');
      await persistenceService.markNewsAsProcessed('news-2');
      await persistenceService.markNewsAsProcessed('news-3');

      const processedIds = await persistenceService.getProcessedNewsIds();

      expect(processedIds).toBeInstanceOf(Set);
      expect(processedIds.size).toBe(3);
      expect(processedIds.has('news-1')).toBe(true);
      expect(processedIds.has('news-2')).toBe(true);
      expect(processedIds.has('news-3')).toBe(true);
    });

    it('should filter processed news by date', async () => {
      await persistenceService.markNewsAsProcessed('news-old');

      // Wait a bit and then add new news
      await new Promise((resolve) => setTimeout(resolve, 100));
      const afterDate = new Date();
      await new Promise((resolve) => setTimeout(resolve, 100));

      await persistenceService.markNewsAsProcessed('news-new');

      const recentIds = await persistenceService.getProcessedNewsIds(afterDate);

      expect(recentIds.size).toBe(1);
      expect(recentIds.has('news-new')).toBe(true);
      expect(recentIds.has('news-old')).toBe(false);
    });

    it('should store news title and content', async () => {
      const newsId = 'news-with-content';
      const title = 'Breaking News: Test Title';
      const content = 'This is the full news content for testing purposes.';

      await persistenceService.markNewsAsProcessed(newsId, { title, content });

      const record = await prisma.processedNews.findUnique({
        where: { newsId },
      });

      expect(record).not.toBeNull();
      expect(record?.title).toBe(title);
      expect(record?.content).toBe(content);
    });
  });

  describe('contract matching', () => {
    it('should save contract matches with LLM validation data', async () => {
      const newsId = 'news-with-matches';
      await persistenceService.markNewsAsProcessed(newsId, { title: 'Test News' });

      const matches: ContractMatch[] = [
        {
          contractTicker: testContractTicker,
          similarity: 0.95,
          relevanceScore: 0.8,
          confidence: 0.75,
          suggestedPosition: 'buy',
          reasoning: 'Strong correlation with news event',
        },
      ];

      const savedCount = await persistenceService.saveContractMatches(newsId, matches);

      expect(savedCount).toBe(1);

      const records = await prisma.processedNewsContract.findMany({
        where: { processedNews: { newsId } },
      });

      expect(records.length).toBe(1);
      expect(records[0].similarity).toBe(0.95);
      expect(records[0].relevanceScore).toBe(0.8);
      expect(records[0].confidence).toBe(0.75);
      expect(records[0].suggestedPosition).toBe('buy');
      expect(records[0].reasoning).toBe('Strong correlation with news event');
    });

    it('should update contract matches on reprocess', async () => {
      const newsId = 'news-reprocess';
      await persistenceService.markNewsAsProcessed(newsId, { title: 'Original Title' });

      // First save with initial data
      await persistenceService.saveContractMatches(newsId, [
        {
          contractTicker: testContractTicker,
          similarity: 0.8,
          relevanceScore: 0.6,
          confidence: 0.5,
          suggestedPosition: 'hold',
        },
      ]);

      // Update with new data
      await persistenceService.saveContractMatches(newsId, [
        {
          contractTicker: testContractTicker,
          similarity: 0.9,
          relevanceScore: 0.85,
          confidence: 0.9,
          suggestedPosition: 'buy',
          reasoning: 'Updated analysis',
        },
      ]);

      const records = await prisma.processedNewsContract.findMany({
        where: { processedNews: { newsId } },
      });

      expect(records.length).toBe(1);
      expect(records[0].similarity).toBe(0.9);
      expect(records[0].confidence).toBe(0.9);
      expect(records[0].suggestedPosition).toBe('buy');
    });

    it('should get contract matches with market context', async () => {
      const newsId = 'news-get-matches';
      await persistenceService.markNewsAsProcessed(newsId, { title: 'Test News' });

      await persistenceService.saveContractMatches(newsId, [
        {
          contractTicker: testContractTicker,
          similarity: 0.88,
          relevanceScore: 0.75,
          confidence: 0.8,
          suggestedPosition: 'sell',
          reasoning: 'Market overpriced',
        },
      ]);

      const matches = await persistenceService.getContractMatches(newsId);

      expect(matches.length).toBe(1);
      expect(matches[0].contractTicker).toBe(testContractTicker);
      expect(matches[0].contractTitle).toBe('Test Contract Option');
      expect(matches[0].marketTitle).toBe('Test Market');
      expect(matches[0].similarity).toBe(0.88);
      expect(matches[0].relevanceScore).toBe(0.75);
      expect(matches[0].confidence).toBe(0.8);
      expect(matches[0].suggestedPosition).toBe('sell');
      expect(matches[0].reasoning).toBe('Market overpriced');
    });

    it('should return empty array for news with no matches', async () => {
      const matches = await persistenceService.getContractMatches('non-existent-news');
      expect(matches).toEqual([]);
    });

    it('should skip invalid contract tickers', async () => {
      const newsId = 'news-invalid-contract';
      await persistenceService.markNewsAsProcessed(newsId, { title: 'Test News' });

      const savedCount = await persistenceService.saveContractMatches(newsId, [
        {
          contractTicker: 'INVALID-CONTRACT-TICKER',
          similarity: 0.9,
          relevanceScore: 0.8,
          confidence: 0.7,
          suggestedPosition: 'buy',
        },
      ]);

      expect(savedCount).toBe(0);
    });
  });

  describe('statistics', () => {
    it('should return recent statistics including contract matches', async () => {
      // Add some test data
      await persistenceService.markNewsAsProcessed('news-stat-1');
      await persistenceService.markNewsAsProcessed('news-stat-2');

      // Add a contract match
      await persistenceService.saveContractMatches('news-stat-1', [
        {
          contractTicker: testContractTicker,
          relevanceScore: 0.8,
          confidence: 0.7,
          suggestedPosition: 'buy',
        },
      ]);

      const stats = await persistenceService.getRecentStats(24);

      expect(stats.newsProcessed).toBe(2);
      expect(stats.contractsMatched).toBe(1);
    });

    it('should filter statistics by time window', async () => {
      // Add some data
      await persistenceService.markNewsAsProcessed('news-recent');

      // Get stats for a very small time window (0.001 hours = 3.6 seconds)
      await new Promise((resolve) => setTimeout(resolve, 4000)); // Wait 4 seconds

      const stats = await persistenceService.getRecentStats(0.001);

      expect(stats.newsProcessed).toBe(0);
    }, 10000); // 10 second timeout for this test
  });

  describe('cleanup', () => {
    it('should clean up old records', async () => {
      // Add some records
      await persistenceService.markNewsAsProcessed('news-to-clean');

      // Clean up with 0 days to keep (should delete everything)
      await persistenceService.cleanup(0);

      // Check that records were deleted
      const processedIds = await persistenceService.getProcessedNewsIds();
      expect(processedIds.size).toBe(0);
    });

    it('should preserve recent records during cleanup', async () => {
      // Add a record
      await persistenceService.markNewsAsProcessed('news-keep');

      // Clean up with 7 days to keep (default)
      await persistenceService.cleanup(7);

      // Recent record should still exist
      const isProcessed = await persistenceService.isNewsProcessed('news-keep');
      expect(isProcessed).toBe(true);
    });
  });

  describe('database lifecycle', () => {
    it('should handle close gracefully', async () => {
      const newService = new PersistenceService();
      await newService.initialize();
      await expect(newService.close()).resolves.not.toThrow();
    });

    it('should handle close when not initialized', async () => {
      const newService = new PersistenceService();
      await expect(newService.close()).resolves.not.toThrow();
    });
  });
});
