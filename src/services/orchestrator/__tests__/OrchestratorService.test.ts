import { OrchestratorService, OrchestratorConfig } from '../OrchestratorService';
import {
  NewsService,
  BettingPlatform,
  LLMProvider,
  NewsItem,
  Contract,
  ParsedNewsInsight,
  Order,
} from '../../../types';
import { AlertService } from '../../alerts/AlertService';
import { AlertConfig } from '../../../config/types';

// Mock AlertService
jest.mock('../../alerts/AlertService');

describe('OrchestratorService', () => {
  let orchestrator: OrchestratorService;
  let config: OrchestratorConfig;
  let mockNewsService: jest.Mocked<NewsService>;
  let mockBettingPlatform: jest.Mocked<BettingPlatform>;
  let mockLLMProvider: jest.Mocked<LLMProvider>;
  let mockAlertService: jest.Mocked<AlertService>;
  let alertConfig: AlertConfig;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();

    config = {
      pollIntervalMs: 60000,
      minRelevanceScore: 0.5,
      minConfidenceScore: 0.6,
      maxPositionsPerContract: 3,
      dryRun: false,
      placeBets: true,
    };

    alertConfig = {
      type: 'system',
      minConfidenceThreshold: 0.6,
    };

    // Create mock alert service
    mockAlertService = {
      sendAlert: jest.fn().mockResolvedValue(undefined),
      testConnection: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<AlertService>;

    // Mock AlertService constructor
    (AlertService as jest.MockedClass<typeof AlertService>).mockImplementation(
      () => mockAlertService,
    );

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
      getAvailableContracts: jest.fn().mockResolvedValue([]),
      getContract: jest.fn().mockResolvedValue(null),
      placeOrder: jest.fn().mockResolvedValue({
        orderId: 'test-order-1',
        status: 'filled' as const,
        filledQuantity: 10,
        averagePrice: 0.5,
        timestamp: new Date(),
      }),
      cancelOrder: jest.fn().mockResolvedValue(true),
      getPositions: jest.fn().mockResolvedValue([]),
      getBalance: jest.fn().mockResolvedValue(10000),
      getMarketResolution: jest.fn().mockResolvedValue(null),
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

    // Initialize orchestrator with services
    orchestrator = new OrchestratorService(
      config,
      [mockNewsService],
      [mockBettingPlatform],
      [mockLLMProvider],
      alertConfig,
    );
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  describe('service management', () => {
    it('should initialize with provided services', () => {
      const orchestratorWithServices = new OrchestratorService(
        config,
        [mockNewsService],
        [mockBettingPlatform],
        [mockLLMProvider],
        alertConfig,
      );
      expect(orchestratorWithServices['newsServices']).toContain(mockNewsService);
      expect(orchestratorWithServices['bettingPlatforms']).toContain(mockBettingPlatform);
      expect(orchestratorWithServices['llmProviders']).toContain(mockLLMProvider);
    });
  });

  describe('start/stop', () => {
    it('should start the orchestrator', async () => {
      await orchestrator.start();
      expect(orchestrator['isRunning']).toBe(true);
      expect(orchestrator['processInterval']).toBeDefined();
    });

    it('should not start if already running', async () => {
      await orchestrator.start();
      const processInterval = orchestrator['processInterval'];

      await orchestrator.start();
      expect(orchestrator['processInterval']).toBe(processInterval);
    });

    it('should stop the orchestrator', async () => {
      await orchestrator.start();
      await orchestrator.stop();

      expect(orchestrator['isRunning']).toBe(false);
      expect(orchestrator['processInterval']).toBeNull();
    });

    it('should run cycle on interval', async () => {
      const processLoopSpy = jest
        .spyOn(orchestrator as unknown as { processLoop: () => Promise<unknown> }, 'processLoop')
        .mockResolvedValue({});

      await orchestrator.start();

      // Fast-forward time
      jest.advanceTimersByTime(config.pollIntervalMs);

      // Wait for async operations
      await Promise.resolve();

      expect(processLoopSpy).toHaveBeenCalledTimes(1); // Once on start
    });
  });

  describe('processLoop with alerts', () => {
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

      await orchestrator['processLoop']();

      expect(mockNewsService.fetchLatestNews).toHaveBeenCalled();
    });

    it('should send alert for high confidence opportunities', async () => {
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

      const mockContracts: Contract[] = [
        {
          id: 'contract-1',
          platform: 'test',
          title: 'Fed Rate Decision - YES',
          yesPrice: 0.65,
          noPrice: 0.35,
          volume: 100000,
          liquidity: 50000,
          endDate: new Date('2024-12-31'),
          tags: ['economics'],
          url: 'https://market.com',
        },
      ];

      mockNewsService.fetchLatestNews.mockResolvedValue(mockNews);
      mockBettingPlatform.getAvailableContracts.mockResolvedValue(mockContracts);

      // Mock parser to return high relevance insight
      jest.spyOn(orchestrator['newsParser'], 'parseNews').mockResolvedValue({
        originalNewsId: 'news-1',
        summary: 'Fed cuts rates',
        entities: [],
        events: [],
        predictions: [],
        sentiment: {
          overall: 0.8,
          confidence: 0.9,
        },
        suggestedActions: [
          {
            type: 'bet',
            description: 'Consider Fed positions',
            urgency: 'high',
            relatedMarketQuery: 'fed rate',
            confidence: 0.8,
          },
        ],
      } as unknown as ParsedNewsInsight);

      // Mock validator to return high confidence validation
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
          suggestedConfidence: 0.9, // High confidence
          risks: [],
          opportunities: ['Rate cut confirmed'],
        },
      ]);

      await orchestrator['processLoop']();

      // Should send alert for high confidence opportunity
      expect(mockAlertService.sendAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          confidence: 0.9,
          contractTitle: expect.any(String),
          marketUrl: expect.any(String),
        }),
      );
    });

    it('should place bets when placeBets is true', async () => {
      config.placeBets = true;

      const mockNews: NewsItem[] = [
        {
          id: 'news-1',
          source: 'test',
          title: 'Market News',
          content: 'Market moving news',
          url: 'https://test.com',
          publishedAt: new Date(),
        },
      ];

      const mockContracts: Contract[] = [
        {
          id: 'contract-1',
          platform: 'test',
          title: 'Market Bet',
          yesPrice: 0.45,
          noPrice: 0.55,
          volume: 50000,
          liquidity: 25000,
          endDate: new Date('2024-12-31'),
          tags: ['test'],
          url: 'https://market.com',
        },
      ];

      mockNewsService.fetchLatestNews.mockResolvedValue(mockNews);
      mockBettingPlatform.getAvailableContracts.mockResolvedValue(mockContracts);

      // Mock parser
      jest.spyOn(orchestrator['newsParser'], 'parseNews').mockResolvedValue({
        originalNewsId: 'news-1',
        summary: 'Market news',
        entities: [],
        events: [],
        predictions: [],
        sentiment: { overall: 0.5, confidence: 0.8 },
        suggestedActions: [
          {
            type: 'bet',
            description: 'Place bet',
            urgency: 'high',
            relatedMarketQuery: 'market',
            confidence: 0.8,
          },
        ],
      } as unknown as ParsedNewsInsight);

      // Mock validator
      jest.spyOn(orchestrator['contractValidator'], 'batchValidateContracts').mockResolvedValue([
        {
          contractId: 'contract-1',
          newsInsightId: 'news-1',
          isRelevant: true,
          relevanceScore: 0.8,
          matchedEntities: [],
          matchedEvents: [],
          reasoning: 'Relevant',
          suggestedPosition: 'buy',
          suggestedConfidence: 0.75,
          risks: [],
          opportunities: [],
        },
      ]);

      await orchestrator['processLoop']();

      expect(mockBettingPlatform.placeOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          contractId: 'contract-1',
          side: 'yes',
          orderType: 'limit',
        } as Order),
      );
    });

    it('should not place bets when placeBets is false', async () => {
      config.placeBets = false;

      const mockNews: NewsItem[] = [
        {
          id: 'news-1',
          source: 'test',
          title: 'Market News',
          content: 'Market moving news',
          url: 'https://test.com',
          publishedAt: new Date(),
        },
      ];

      const mockContracts: Contract[] = [
        {
          id: 'contract-1',
          platform: 'test',
          title: 'Market Bet',
          yesPrice: 0.45,
          noPrice: 0.55,
          volume: 50000,
          liquidity: 25000,
          endDate: new Date('2024-12-31'),
          tags: ['test'],
          url: 'https://market.com',
        },
      ];

      mockNewsService.fetchLatestNews.mockResolvedValue(mockNews);
      mockBettingPlatform.getAvailableContracts.mockResolvedValue(mockContracts);

      // Mock parser
      jest.spyOn(orchestrator['newsParser'], 'parseNews').mockResolvedValue({
        originalNewsId: 'news-1',
        summary: 'Market news',
        entities: [],
        events: [],
        predictions: [],
        sentiment: { overall: 0.5, confidence: 0.8 },
        suggestedActions: [
          {
            type: 'bet',
            description: 'Place bet',
            urgency: 'high',
            relatedMarketQuery: 'market',
            confidence: 0.8,
          },
        ],
      } as unknown as ParsedNewsInsight);

      // Mock validator
      jest.spyOn(orchestrator['contractValidator'], 'batchValidateContracts').mockResolvedValue([
        {
          contractId: 'contract-1',
          newsInsightId: 'news-1',
          isRelevant: true,
          relevanceScore: 0.8,
          matchedEntities: [],
          matchedEvents: [],
          reasoning: 'Relevant',
          suggestedPosition: 'buy',
          suggestedConfidence: 0.75,
          risks: [],
          opportunities: [],
        },
      ]);

      await orchestrator['processLoop']();

      expect(mockBettingPlatform.placeOrder).not.toHaveBeenCalled();
    });

    it('should handle errors gracefully', async () => {
      mockNewsService.fetchLatestNews.mockRejectedValue(new Error('Network error'));

      const result = await orchestrator['processLoop']();

      expect(result.errors).toContain('Processing loop error: Error: Network error');
    });
  });

  describe('testContract', () => {
    it('should test contracts for a specific platform', async () => {
      const mockContracts: Contract[] = [
        {
          id: 'test-contract-1',
          platform: 'mock-platform',
          title: 'Test Contract',
          yesPrice: 0.5,
          noPrice: 0.5,
          volume: 1000,
          liquidity: 500,
          endDate: new Date('2024-12-31'),
          tags: ['test'],
          url: 'https://test.com',
        },
      ];

      mockBettingPlatform.getAvailableContracts.mockResolvedValue(mockContracts);

      const result = await orchestrator.testContract('mock-platform', 'test');

      expect(result).toEqual(mockContracts);
    });

    it('should return empty array for unknown platform', async () => {
      const result = await orchestrator.testContract('unknown-platform', 'test');
      expect(result).toEqual([]);
    });
  });
});
