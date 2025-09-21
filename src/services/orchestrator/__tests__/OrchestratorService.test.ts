import { OrchestratorService, OrchestratorConfig } from '../OrchestratorService';
import {
  NewsService,
  BettingPlatform,
  LLMProvider,
  NewsItem,
  Market,
  Contract,
  ParsedNewsInsight,
} from '../../../types';

describe('OrchestratorService', () => {
  let orchestrator: OrchestratorService;
  let config: OrchestratorConfig;
  let mockNewsService: jest.Mocked<NewsService>;
  let mockBettingPlatform: jest.Mocked<BettingPlatform>;
  let mockLLMProvider: jest.Mocked<LLMProvider>;

  beforeEach(() => {
    jest.useFakeTimers();

    config = {
      pollIntervalMs: 60000,
      minRelevanceScore: 0.5,
      minConfidenceScore: 0.6,
      maxPositionsPerContract: 3,
      dryRun: true,
    };

    orchestrator = new OrchestratorService(config);

    // Create mock news service
    mockNewsService = {
      name: 'mock-news',
      initialize: jest.fn().mockResolvedValue(undefined),
      fetchLatestNews: jest.fn().mockResolvedValue([]),
      searchNews: jest.fn().mockResolvedValue([]),
      isHealthy: jest.fn().mockResolvedValue(true),
      destroy: jest.fn().mockResolvedValue(undefined),
    };

    // Create mock betting platform
    mockBettingPlatform = {
      name: 'mock-platform',
      initialize: jest.fn().mockResolvedValue(undefined),
      searchMarkets: jest.fn().mockResolvedValue([]),
      getMarket: jest.fn(),
      getContracts: jest.fn().mockResolvedValue([]),
      getContract: jest.fn(),
      placeOrder: jest.fn(),
      getPosition: jest.fn(),
      getPositions: jest.fn().mockResolvedValue([]),
      cancelOrder: jest.fn().mockResolvedValue(undefined),
      isHealthy: jest.fn().mockResolvedValue(true),
      destroy: jest.fn().mockResolvedValue(undefined),
    };

    // Create mock LLM provider
    mockLLMProvider = {
      name: 'mock-llm',
      initialize: jest.fn().mockResolvedValue(undefined),
      generateCompletion: jest.fn().mockResolvedValue('Analysis result'),
      generateStructuredOutput: jest.fn().mockResolvedValue({}),
      isHealthy: jest.fn().mockResolvedValue(true),
      destroy: jest.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  describe('service management', () => {
    it('should add news service', () => {
      orchestrator.addNewsService(mockNewsService);
      expect(orchestrator['newsServices']).toContain(mockNewsService);
    });

    it('should add betting platform', () => {
      orchestrator.addBettingPlatform(mockBettingPlatform);
      expect(orchestrator['bettingPlatforms']).toContain(mockBettingPlatform);
    });

    it('should add LLM provider', () => {
      orchestrator.addLLMProvider(mockLLMProvider);
      expect(orchestrator['llmProviders']).toContain(mockLLMProvider);
    });
  });

  describe('start/stop', () => {
    it('should start the orchestrator', async () => {
      await orchestrator.start();
      expect(orchestrator['isRunning']).toBe(true);
      expect(orchestrator['pollInterval']).toBeDefined();
    });

    it('should not start if already running', async () => {
      await orchestrator.start();
      const pollInterval = orchestrator['pollInterval'];

      await orchestrator.start();
      expect(orchestrator['pollInterval']).toBe(pollInterval);
    });

    it('should stop the orchestrator', async () => {
      await orchestrator.start();
      await orchestrator.stop();

      expect(orchestrator['isRunning']).toBe(false);
      expect(orchestrator['pollInterval']).toBeUndefined();
    });

    it('should run cycle on interval', async () => {
      const runCycleSpy = jest
        .spyOn(orchestrator as unknown as { runCycle: () => Promise<void> }, 'runCycle')
        .mockResolvedValue();

      await orchestrator.start();

      // Fast-forward time
      jest.advanceTimersByTime(config.pollIntervalMs);

      // Wait for async operations
      await Promise.resolve();

      expect(runCycleSpy).toHaveBeenCalledTimes(2); // Once on start, once on interval
    });
  });

  describe('runCycle', () => {
    beforeEach(() => {
      orchestrator.addNewsService(mockNewsService);
      orchestrator.addBettingPlatform(mockBettingPlatform);
      orchestrator.addLLMProvider(mockLLMProvider);
    });

    it('should fetch and process news', async () => {
      const mockNews: NewsItem[] = [
        {
          id: 'news-1',
          source: 'test',
          title: 'Test News',
          content: 'Test content',
          url: 'https://test.com',
          publishedAt: new Date(),
        },
      ];

      mockNewsService.fetchLatestNews.mockResolvedValue(mockNews);

      const result = await orchestrator['runCycle']();

      expect(mockNewsService.fetchLatestNews).toHaveBeenCalled();
      expect(result.newsProcessed).toBe(1);
    });

    it('should handle no news gracefully', async () => {
      mockNewsService.fetchLatestNews.mockResolvedValue([]);

      const result = await orchestrator['runCycle']();

      expect(result.newsProcessed).toBe(0);
      expect(result.insightsGenerated).toBe(0);
    });

    it('should skip low relevance insights', async () => {
      const mockNews: NewsItem[] = [
        {
          id: 'news-1',
          source: 'test',
          title: 'Test News',
          content: 'Test content',
          url: 'https://test.com',
          publishedAt: new Date(),
        },
      ];

      mockNewsService.fetchLatestNews.mockResolvedValue(mockNews);

      // Mock parser to return low relevance insight
      jest.spyOn(orchestrator['newsParser'], 'parseNews').mockResolvedValue({
        originalNewsId: 'news-1',
        summary: 'Test',
        entities: [],
        events: [],
        predictions: [],
        sentiment: { overall: 0, positive: 0, negative: 0, neutral: 1 },
        relevanceScore: 0.3, // Below minimum
        suggestedActions: [],
      } as ParsedNewsInsight);

      const result = await orchestrator['runCycle']();

      expect(result.insightsGenerated).toBe(1);
      expect(result.marketsSearched).toBe(0); // Skipped due to low relevance
    });

    it('should search markets for high relevance insights', async () => {
      const mockNews: NewsItem[] = [
        {
          id: 'news-1',
          source: 'test',
          title: 'Fed Rate Cut',
          content: 'Federal Reserve cuts rates',
          url: 'https://test.com',
          publishedAt: new Date(),
        },
      ];

      const mockMarkets: Market[] = [
        {
          id: 'market-1',
          platform: 'test',
          title: 'Fed Rate Decision',
          description: 'Will Fed cut rates?',
          url: 'https://market.com',
          createdAt: new Date(),
        },
      ];

      const mockContracts: Contract[] = [
        {
          id: 'contract-1',
          marketId: 'market-1',
          platform: 'test',
          title: 'YES',
          description: 'Yes outcome',
          outcome: 'YES',
          currentPrice: 0.65,
        },
      ];

      mockNewsService.fetchLatestNews.mockResolvedValue(mockNews);
      mockBettingPlatform.searchMarkets.mockResolvedValue(mockMarkets);
      mockBettingPlatform.getContracts.mockResolvedValue(mockContracts);

      // Mock parser to return high relevance insight
      jest.spyOn(orchestrator['newsParser'], 'parseNews').mockResolvedValue({
        originalNewsId: 'news-1',
        summary: 'Fed cuts rates',
        entities: [],
        events: [],
        predictions: [],
        sentiment: { overall: 0.5, positive: 0.7, negative: 0.2, neutral: 0.1 },
        relevanceScore: 0.8,
        suggestedActions: [
          {
            type: 'bet',
            description: 'Consider Fed positions',
            urgency: 'high',
            relatedMarketQuery: 'fed rate',
            confidence: 0.8,
          },
        ],
      } as ParsedNewsInsight);

      // Mock validator to return relevant validation
      jest.spyOn(orchestrator['contractValidator'], 'batchValidateContracts').mockResolvedValue([
        {
          contractId: 'contract-1',
          newsInsightId: 'news-1',
          isRelevant: true,
          relevanceScore: 0.85,
          matchedEntities: ['Federal Reserve'],
          matchedEvents: [],
          reasoning: 'Highly relevant',
          suggestedPosition: 'buy',
          suggestedConfidence: 0.75,
          risks: [],
          opportunities: [],
        },
      ]);

      const result = await orchestrator['runCycle']();

      expect(mockBettingPlatform.searchMarkets).toHaveBeenCalledWith('fed rate');
      expect(result.contractsValidated).toBeGreaterThan(0);
    });

    it('should place orders in dry run mode', async () => {
      config.dryRun = true;
      orchestrator = new OrchestratorService(config);
      orchestrator.addNewsService(mockNewsService);
      orchestrator.addBettingPlatform(mockBettingPlatform);
      orchestrator.addLLMProvider(mockLLMProvider);

      const mockNews: NewsItem[] = [
        {
          id: 'news-1',
          source: 'test',
          title: 'Test News',
          content: 'Test content',
          url: 'https://test.com',
          publishedAt: new Date(),
        },
      ];

      mockNewsService.fetchLatestNews.mockResolvedValue(mockNews);

      // Mock high confidence validation
      jest.spyOn(orchestrator['contractValidator'], 'batchValidateContracts').mockResolvedValue([
        {
          contractId: 'contract-1',
          newsInsightId: 'news-1',
          isRelevant: true,
          relevanceScore: 0.85,
          matchedEntities: [],
          matchedEvents: [],
          reasoning: 'Relevant',
          suggestedPosition: 'buy',
          suggestedConfidence: 0.8, // Above minimum
          risks: [],
          opportunities: [],
        },
      ]);

      jest.spyOn(orchestrator['newsParser'], 'parseNews').mockResolvedValue({
        originalNewsId: 'news-1',
        summary: 'Test',
        entities: [],
        events: [],
        predictions: [],
        sentiment: { overall: 0.5, positive: 0.7, negative: 0.2, neutral: 0.1 },
        relevanceScore: 0.8,
        suggestedActions: [
          {
            type: 'bet',
            description: 'Test',
            urgency: 'high',
            relatedMarketQuery: 'test',
            confidence: 0.8,
          },
        ],
      } as ParsedNewsInsight);

      mockBettingPlatform.searchMarkets.mockResolvedValue([
        {
          id: 'market-1',
          platform: 'test',
          title: 'Test Market',
          description: 'Test',
          url: 'https://test.com',
          createdAt: new Date(),
        },
      ]);

      mockBettingPlatform.getContracts.mockResolvedValue([
        {
          id: 'contract-1',
          marketId: 'market-1',
          platform: 'test',
          title: 'YES',
          description: 'Yes',
          outcome: 'YES',
          currentPrice: 0.5,
        },
      ]);

      const result = await orchestrator['runCycle']();

      expect(result.positionsCreated).toBe(1);
      expect(mockBettingPlatform.placeOrder).not.toHaveBeenCalled(); // Dry run
    });

    it('should handle errors gracefully', async () => {
      // Mock a service that works and returns news
      const mockNews: NewsItem[] = [
        {
          id: 'news-1',
          source: 'test',
          title: 'Test News',
          content: 'Test content',
          url: 'https://test.com',
          publishedAt: new Date(),
        },
      ];

      mockNewsService.fetchLatestNews.mockResolvedValue(mockNews);

      // Mock parser to throw an error
      jest
        .spyOn(orchestrator['newsParser'], 'parseNews')
        .mockRejectedValue(new Error('Parser Error'));

      const result = await orchestrator['runCycle']();

      // Service errors are caught and logged, not returned
      expect(result.newsProcessed).toBe(1);
      expect(result.insightsGenerated).toBe(0); // Failed to parse
    });
  });

  describe('getStatus', () => {
    it('should return current status', async () => {
      orchestrator.addNewsService(mockNewsService);
      orchestrator.addBettingPlatform(mockBettingPlatform);
      orchestrator.addLLMProvider(mockLLMProvider);

      await orchestrator.start();

      const status = await orchestrator.getStatus();

      expect(status).toMatchObject({
        isRunning: true,
        services: {
          news: 1,
          betting: 1,
          llm: 1,
        },
        config: config,
      });
    });
  });

  describe('order placement', () => {
    it('should calculate order quantity based on confidence', () => {
      const validation = {
        contractId: 'test',
        newsInsightId: 'test',
        isRelevant: true,
        relevanceScore: 0.8,
        matchedEntities: [],
        matchedEvents: [],
        reasoning: 'test',
        suggestedPosition: 'buy' as const,
        suggestedConfidence: 0.75,
        risks: [],
        opportunities: [],
      };

      const contract = {
        id: 'test',
        marketId: 'test',
        platform: 'test',
        title: 'test',
        description: 'test',
        outcome: 'YES',
        currentPrice: 0.5,
      };

      const quantity = orchestrator['calculateOrderQuantity'](validation, contract);

      expect(quantity).toBe(Math.floor(10 * 0.75 * 0.8)); // base * confidence * relevance
    });
  });
});
