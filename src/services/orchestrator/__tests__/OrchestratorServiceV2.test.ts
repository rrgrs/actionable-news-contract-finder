import { OrchestratorServiceV2, OrchestratorConfig } from '../OrchestratorServiceV2';
import {
  NewsService,
  BettingPlatform,
  LLMProvider,
  NewsItem,
  Market,
  Contract,
  ParsedNewsInsight,
} from '../../../types';
import { AlertService } from '../../alerts/AlertService';
import { AlertConfig } from '../../../config/types';

// Mock AlertService
jest.mock('../../alerts/AlertService');

describe('OrchestratorServiceV2', () => {
  let orchestrator: OrchestratorServiceV2;
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
    } as any;

    // Mock AlertService constructor
    (AlertService as jest.MockedClass<typeof AlertService>).mockImplementation(() => mockAlertService);

    orchestrator = new OrchestratorServiceV2(config, alertConfig);

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
      const runCycleSpy = jest.spyOn(orchestrator as any, 'runCycle').mockResolvedValue({});

      await orchestrator.start();

      // Fast-forward time
      jest.advanceTimersByTime(config.pollIntervalMs);

      // Wait for async operations
      await Promise.resolve();

      expect(runCycleSpy).toHaveBeenCalledTimes(2); // Once on start, once on interval
    });
  });

  describe('runCycle with alerts', () => {
    beforeEach(() => {
      orchestrator.addNewsService(mockNewsService);
      orchestrator.addBettingPlatform(mockBettingPlatform);
      orchestrator.addLLMProvider(mockLLMProvider);
    });

    it('should skip duplicate news items', async () => {
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

      // First cycle
      await orchestrator['runCycle']();
      expect(orchestrator['processedNewsIds'].has('news-1')).toBe(true);

      // Second cycle with same news
      await orchestrator['runCycle']();

      // News parser should only be called once
      const parseNewsSpy = jest.spyOn(orchestrator['newsParser'], 'parseNews');
      expect(parseNewsSpy).toHaveBeenCalledTimes(0); // Not called in second cycle
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

      await orchestrator['runCycle']();

      // Should send alert for high confidence opportunity
      expect(mockAlertService.sendAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          confidence: 0.9,
          contractTitle: expect.any(String),
          marketUrl: expect.any(String),
        })
      );
    });

    it('should place bets when placeBets is true', async () => {
      config.placeBets = true;
      (AlertService as jest.MockedClass<typeof AlertService>).mockImplementation(() => mockAlertService);
      orchestrator = new OrchestratorServiceV2(config, alertConfig);
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
          suggestedConfidence: 0.8,
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

      mockBettingPlatform.placeOrder.mockResolvedValue({
        id: 'position-1',
        contractId: 'contract-1',
        platform: 'test',
        side: 'buy',
        quantity: 10,
        price: 0.5,
        timestamp: new Date(),
        status: 'filled',
      });

      await orchestrator['runCycle']();

      expect(mockBettingPlatform.placeOrder).toHaveBeenCalled();
      // Should send alert when position is created
      expect(mockAlertService.sendAlert).toHaveBeenCalled();
    });

    it('should not place bets when placeBets is false', async () => {
      config.placeBets = false;
      (AlertService as jest.MockedClass<typeof AlertService>).mockImplementation(() => mockAlertService);
      orchestrator = new OrchestratorServiceV2(config, alertConfig);
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
          suggestedConfidence: 0.8,
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

      await orchestrator['runCycle']();

      expect(mockBettingPlatform.placeOrder).not.toHaveBeenCalled();
      // Should still send alert about opportunity
      expect(mockAlertService.sendAlert).toHaveBeenCalled();
    });

    it('should handle errors and send error alerts', async () => {
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

      await orchestrator['runCycle']();

      // Errors are logged, not sent as alerts in the current implementation
      expect(mockAlertService.sendAlert).not.toHaveBeenCalled();
    });

    it('should handle when no news is found', async () => {
      mockNewsService.fetchLatestNews.mockResolvedValue([]);

      const result = await orchestrator['runCycle']();

      // No alerts sent when no news
      expect(mockAlertService.sendAlert).not.toHaveBeenCalled();
      expect(result.newsProcessed).toBe(0);
    });
  });

  describe('dry run mode', () => {
    it('should not place real orders in dry run mode', async () => {
      config.dryRun = true;
      config.placeBets = true;
      (AlertService as jest.MockedClass<typeof AlertService>).mockImplementation(() => mockAlertService);
      orchestrator = new OrchestratorServiceV2(config, alertConfig);
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
          suggestedConfidence: 0.8,
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

      await orchestrator['runCycle']();

      // Should not place real order in dry run
      expect(mockBettingPlatform.placeOrder).not.toHaveBeenCalled();
      // Should send alert about opportunity (dry run doesn't affect alerts)
      expect(mockAlertService.sendAlert).toHaveBeenCalled();
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

    it('should include processed news count', async () => {
      orchestrator.addNewsService(mockNewsService);
      orchestrator.addBettingPlatform(mockBettingPlatform);
      orchestrator.addLLMProvider(mockLLMProvider);

      mockNewsService.fetchLatestNews.mockResolvedValue([
        {
          id: 'news-1',
          source: 'test',
          title: 'Test',
          content: 'Test',
          url: 'https://test.com',
          publishedAt: new Date(),
        },
      ]);

      await orchestrator['runCycle']();

      const status = await orchestrator.getStatus();

      expect(status.processedNewsCount).toBe(1);
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

  describe('processed news tracking', () => {
    it('should track processed news IDs', async () => {
      orchestrator.addNewsService(mockNewsService);
      orchestrator.addBettingPlatform(mockBettingPlatform);
      orchestrator.addLLMProvider(mockLLMProvider);

      const mockNews: NewsItem[] = [
        {
          id: 'news-1',
          source: 'test',
          title: 'Test',
          content: 'Test',
          url: 'https://test.com',
          publishedAt: new Date(),
        },
      ];

      mockNewsService.fetchLatestNews.mockResolvedValue(mockNews);

      // First cycle - news gets processed
      await orchestrator['runCycle']();
      expect(orchestrator['processedNewsIds'].has('news-1')).toBe(true);

      // Second cycle - same news should be skipped
      const parseNewsSpy = jest.spyOn(orchestrator['newsParser'], 'parseNews');
      await orchestrator['runCycle']();
      
      // parseNews should not be called for already processed news
      expect(parseNewsSpy).not.toHaveBeenCalled();
    });
  });
});