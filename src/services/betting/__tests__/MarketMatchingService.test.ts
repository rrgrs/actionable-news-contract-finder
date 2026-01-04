import { PrismaClient, Market, Contract } from '@prisma/client';
import { MarketMatchingService } from '../MarketMatchingService';
import { EmbeddingService } from '../../embedding/EmbeddingService';
import { NewsItem } from '../../../types';

// Mock dependencies
jest.mock('../../embedding/EmbeddingService');

describe('MarketMatchingService', () => {
  let service: MarketMatchingService;
  let mockPrisma: jest.Mocked<PrismaClient>;
  let mockEmbeddingService: jest.Mocked<EmbeddingService>;

  // Create mock data matching the raw SQL result structure
  const createSimilarMarketRow = (id: number, title: string, similarity: number) => ({
    id,
    platform: 'mock-platform',
    event_ticker: `event-${id}`,
    series_ticker: `series-${id}`,
    title,
    url: `https://example.com/market/${id}`,
    category: 'test-category',
    end_date: null,
    is_active: true,
    last_synced_at: new Date(),
    created_at: new Date(),
    updated_at: new Date(),
    similarity,
  });

  const createMockContract = (id: number, marketId: number, title: string) => ({
    id,
    marketId,
    contractTicker: `contract-${marketId}-${id}`,
    title,
    yesPrice: 0.6,
    noPrice: 0.4,
    volume: 1000,
    liquidity: 500,
    metadata: null,
    isActive: true,
    lastSyncedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const createMockMarket = (id: number, title: string): Market & { contracts: Contract[] } => ({
    id,
    platform: 'mock-platform',
    eventTicker: `event-${id}`,
    seriesTicker: `series-${id}`,
    title,
    url: `https://example.com/market/${id}`,
    category: 'test-category',
    endDate: null,
    isActive: true,
    embeddingUpdatedAt: null,
    lastSyncedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    contracts: [
      {
        id: id * 100,
        marketId: id,
        contractTicker: `contract-${id}-1`,
        title: 'Yes option',
        yesPrice: 0.6,
        noPrice: 0.4,
        volume: 1000,
        liquidity: 500,
        metadata: null,
        isActive: true,
        lastSyncedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: id * 100 + 1,
        marketId: id,
        contractTicker: `contract-${id}-2`,
        title: 'No option',
        yesPrice: 0.4,
        noPrice: 0.6,
        volume: 800,
        liquidity: 400,
        metadata: null,
        isActive: true,
        lastSyncedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
  });

  const createMockNewsItem = (id: string, title: string): NewsItem => ({
    id,
    source: 'test-source',
    title,
    content: `Content for ${title}`,
    url: `https://news.com/${id}`,
    publishedAt: new Date(),
  });

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock PrismaClient with $queryRaw for pgvector queries
    mockPrisma = {
      $queryRaw: jest.fn(),
      market: {
        findMany: jest.fn(),
        count: jest.fn(),
      },
      contract: {
        findMany: jest.fn(),
        count: jest.fn(),
      },
    } as unknown as jest.Mocked<PrismaClient>;

    // Mock EmbeddingService
    mockEmbeddingService = {
      generateEmbedding: jest.fn(),
      generateEmbeddings: jest.fn(),
    } as unknown as jest.Mocked<EmbeddingService>;

    // Create service instance
    service = new MarketMatchingService(mockPrisma, mockEmbeddingService, {
      topN: 50,
      minSimilarity: undefined,
    });
  });

  describe('initialize', () => {
    it('should initialize successfully', async () => {
      await expect(service.initialize()).resolves.not.toThrow();
    });
  });

  describe('findMatchingMarkets', () => {
    it('should find matching markets based on embedding similarity using pgvector', async () => {
      await service.initialize();

      const newsItem = createMockNewsItem('news-1', 'Tesla announces new electric car');

      // Mock news embedding
      const newsEmbedding = [1, 0, 0];
      mockEmbeddingService.generateEmbedding.mockResolvedValue(newsEmbedding);

      // Mock pgvector similarity query results
      const similarMarketRows = [
        createSimilarMarketRow(1, 'Will Tesla release new car in 2024?', 0.99),
        createSimilarMarketRow(3, 'Tesla stock price above $300?', 0.97),
      ];
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue(similarMarketRows);

      // Mock contracts for the matched markets
      const contracts = [
        createMockContract(100, 1, 'Yes option'),
        createMockContract(101, 1, 'No option'),
        createMockContract(300, 3, 'Yes option'),
      ];
      (mockPrisma.contract.findMany as jest.Mock).mockResolvedValue(contracts);

      const result = await service.findMatchingMarkets(newsItem);

      expect(result.length).toBe(2);
      expect(mockEmbeddingService.generateEmbedding).toHaveBeenCalled();
      expect(mockPrisma.$queryRaw).toHaveBeenCalled();
      // Check that markets have contracts
      expect(result[0].contracts.length).toBe(2);
      expect(result[0].similarity).toBe(0.99);
    });

    it('should return empty array when news embedding fails', async () => {
      await service.initialize();

      const newsItem = createMockNewsItem('news-1', 'Test news');
      mockEmbeddingService.generateEmbedding.mockResolvedValue([]);

      const result = await service.findMatchingMarkets(newsItem);

      expect(result).toEqual([]);
    });

    it('should return empty array when no markets match', async () => {
      await service.initialize();

      const newsItem = createMockNewsItem('news-1', 'Test news');
      mockEmbeddingService.generateEmbedding.mockResolvedValue([1, 0, 0]);
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);

      const result = await service.findMatchingMarkets(newsItem);

      expect(result).toEqual([]);
    });
  });

  describe('findMatchingMarketsForBatch', () => {
    it('should process multiple news items using pgvector', async () => {
      await service.initialize();

      const newsItems = [
        createMockNewsItem('news-1', 'Tesla news'),
        createMockNewsItem('news-2', 'Apple news'),
      ];

      mockEmbeddingService.generateEmbeddings.mockResolvedValue([
        [1, 0, 0],
        [0, 1, 0],
      ]);

      // Mock pgvector similarity query results
      const similarMarketRows = [createSimilarMarketRow(1, 'Tesla market', 0.9)];
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue(similarMarketRows);

      // Mock contracts
      const contracts = [createMockContract(100, 1, 'Yes option')];
      (mockPrisma.contract.findMany as jest.Mock).mockResolvedValue(contracts);

      const result = await service.findMatchingMarketsForBatch(newsItems);

      expect(result.size).toBe(2);
      expect(result.has('news-1')).toBe(true);
      expect(result.has('news-2')).toBe(true);
    });
  });

  describe('formatMarketsForPrompt', () => {
    it('should format markets with contracts', async () => {
      await service.initialize();

      const market = createMockMarket(1, 'Will Tesla hit $500?');
      market.endDate = new Date('2024-12-31');

      const matchedMarkets = [
        {
          market: {
            id: market.id.toString(),
            platform: market.platform,
            eventTicker: market.eventTicker,
            seriesTicker: market.seriesTicker || undefined,
            title: market.title,
            url: market.url,
            category: market.category || undefined,
            endDate: market.endDate || undefined,
            metadata: {},
            contracts: market.contracts.map((c) => ({
              id: c.id.toString(),
              contractTicker: c.contractTicker,
              platform: market.platform, // Platform comes from market
              title: c.title,
              yesPrice: c.yesPrice,
              noPrice: c.noPrice,
              volume: c.volume,
              liquidity: c.liquidity,
              metadata: {},
            })),
          },
          contracts: market.contracts.map((c) => ({
            id: c.id.toString(),
            contractTicker: c.contractTicker,
            platform: market.platform, // Platform comes from market
            title: c.title,
            yesPrice: c.yesPrice,
            noPrice: c.noPrice,
            volume: c.volume,
            liquidity: c.liquidity,
            metadata: {},
          })),
          similarity: 0.95,
        },
      ];

      const formatted = service.formatMarketsForPrompt(matchedMarkets);

      expect(formatted).toContain('[1]');
      expect(formatted).toContain('Will Tesla hit $500?');
      expect(formatted).toContain('mock-platform');
      expect(formatted).toContain('Similarity: 95.0%');
      expect(formatted).toContain('Options:');
    });

    it('should limit to maxMarkets', async () => {
      await service.initialize();

      const matchedMarkets = Array(50)
        .fill(null)
        .map((_, i) => {
          const market = createMockMarket(i, `Market ${i}`);
          return {
            market: {
              id: market.id.toString(),
              platform: market.platform,
              eventTicker: market.eventTicker,
              title: market.title,
              url: market.url,
              metadata: {},
              contracts: [],
            },
            contracts: [],
            similarity: 0.9 - i * 0.01,
          };
        });

      const formatted = service.formatMarketsForPrompt(matchedMarkets, 5);

      // Count market entries (lines starting with '[')
      const marketLines = formatted.split('\n').filter((l) => l.startsWith('['));
      expect(marketLines.length).toBe(5);
    });
  });

  describe('getStats', () => {
    it('should return service statistics', async () => {
      await service.initialize();

      (mockPrisma.market.count as jest.Mock).mockResolvedValue(100);
      (mockPrisma.contract.count as jest.Mock).mockResolvedValue(500);
      // Mock the raw query for embeddings count
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([{ count: BigInt(80) }]);

      const stats = await service.getStats();

      expect(stats).toHaveProperty('totalActiveMarkets');
      expect(stats).toHaveProperty('totalActiveContracts');
      expect(stats).toHaveProperty('marketsWithEmbeddings');
    });
  });
});
