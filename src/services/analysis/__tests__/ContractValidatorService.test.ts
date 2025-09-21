import { ContractValidatorService } from '../ContractValidatorService';
import { Contract, ParsedNewsInsight, LLMProvider } from '../../../types';

describe('ContractValidatorService', () => {
  let validator: ContractValidatorService;
  let mockLLMProvider: LLMProvider;
  let testContract: Contract;
  let testNewsInsight: ParsedNewsInsight;

  beforeEach(() => {
    validator = new ContractValidatorService();

    mockLLMProvider = {
      name: 'mock-llm',
      initialize: jest.fn(),
      generateCompletion: jest
        .fn()
        .mockResolvedValue(
          'This contract is highly relevant to the news. Direct correlation found. Buy recommended.',
        ),
      generateStructuredOutput: jest.fn(),
      isHealthy: jest.fn().mockResolvedValue(true),
      destroy: jest.fn(),
    };

    testContract = {
      id: 'contract-1',
      platform: 'test-platform',
      title: 'Fed Cuts Rates in Q1',
      description: 'Will the Federal Reserve cut interest rates in Q1?',
      yesPrice: 0.65,
      noPrice: 0.35,
      volume: 100000,
      liquidity: 50000,
      endDate: new Date('2024-03-31'),
      tags: ['economics', 'fed'],
      url: 'https://example.com/market',
      metadata: {
        previousPrice: 0.6,
      },
    };

    testNewsInsight = {
      originalNewsId: 'news-1',
      summary: 'Fed announces rate cut',
      entities: [{ type: 'organization', name: 'Federal Reserve', confidence: 0.95 }],
      events: [
        {
          type: 'monetary_policy',
          description: 'Federal Reserve rate cut',
          probability: 0.8,
          impact: 'high',
        },
      ],
      predictions: [
        {
          outcome: 'Market rally',
          probability: 0.7,
          confidence: 0.75,
          timeframe: 'Short-term',
        },
      ],
      sentiment: {
        overall: 0.6,
        positive: 0.7,
        negative: 0.1,
        neutral: 0.2,
      },
      relevanceScore: 0.85,
      suggestedActions: [
        {
          type: 'bet',
          description: 'Consider Fed rate positions',
          urgency: 'high',
          relatedMarketQuery: 'federal reserve',
          confidence: 0.8,
        },
      ],
    };
  });

  describe('validateContract', () => {
    it('should validate a contract against news insight', async () => {
      const result = await validator.validateContract(
        testContract,
        testNewsInsight,
        mockLLMProvider,
      );

      expect(result).toMatchObject({
        contractId: 'contract-1',
        newsInsightId: 'news-1',
        isRelevant: expect.any(Boolean),
        relevanceScore: expect.any(Number),
        matchedEntities: expect.any(Array),
        matchedEvents: expect.any(Array),
        reasoning: expect.any(String),
        suggestedConfidence: expect.any(Number),
        risks: expect.any(Array),
        opportunities: expect.any(Array),
      });
    });

    it('should call LLM provider with correct prompt', async () => {
      await validator.validateContract(testContract, testNewsInsight, mockLLMProvider);

      expect(mockLLMProvider.generateCompletion).toHaveBeenCalledWith(
        expect.stringContaining('Fed Cuts Rates in Q1'),
        expect.stringContaining('prediction market analyst'),
      );
    });

    it('should identify relevant contract', async () => {
      const result = await validator.validateContract(
        testContract,
        testNewsInsight,
        mockLLMProvider,
      );

      expect(result.isRelevant).toBe(true);
      expect(result.relevanceScore).toBeGreaterThan(0.5);
    });

    it('should match entities correctly', async () => {
      const result = await validator.validateContract(
        testContract,
        testNewsInsight,
        mockLLMProvider,
      );

      expect(result.matchedEntities).toContain('Federal Reserve');
    });

    it('should match events correctly', async () => {
      const result = await validator.validateContract(
        testContract,
        testNewsInsight,
        mockLLMProvider,
      );

      expect(result.matchedEvents).toContain('Federal Reserve rate cut');
    });

    it('should suggest position based on sentiment', async () => {
      const result = await validator.validateContract(
        testContract,
        testNewsInsight,
        mockLLMProvider,
      );

      expect(result.suggestedPosition).toBe('buy'); // Positive sentiment + YES outcome
    });

    it('should identify risks', async () => {
      const expiringSoonContract = {
        ...testContract,
        expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000), // 3 days
      };

      const result = await validator.validateContract(
        expiringSoonContract,
        testNewsInsight,
        mockLLMProvider,
      );

      const expiryRisk = result.risks.find((r) => r.includes('expires soon'));
      expect(expiryRisk).toBeDefined();
    });

    it('should identify opportunities', async () => {
      const underpricedContract = {
        ...testContract,
        currentPrice: 0.25,
      };

      const result = await validator.validateContract(
        underpricedContract,
        testNewsInsight,
        mockLLMProvider,
      );

      const opportunity = result.opportunities.find((o) => o.includes('underpriced'));
      expect(opportunity).toBeDefined();
    });

    it('should suggest hold for unclear analysis', async () => {
      mockLLMProvider.generateCompletion = jest
        .fn()
        .mockResolvedValue('Unclear connection between contract and news');

      const neutralInsight = {
        ...testNewsInsight,
        sentiment: { overall: 0, positive: 0.3, negative: 0.3, neutral: 0.4 },
      };

      const result = await validator.validateContract(
        testContract,
        neutralInsight,
        mockLLMProvider,
      );

      expect(result.suggestedPosition).toBe('hold');
    });
  });

  describe('batchValidateContracts', () => {
    it('should validate multiple contracts', async () => {
      const contracts = [
        testContract,
        { ...testContract, id: 'contract-2', outcome: 'NO', currentPrice: 0.35 },
      ];

      const results = await validator.batchValidateContracts(
        contracts,
        testNewsInsight,
        mockLLMProvider,
      );

      expect(results).toHaveLength(2);
      expect(results[0].contractId).toBe('contract-1');
      expect(results[1].contractId).toBe('contract-2');
    });

    it('should sort by relevance score', async () => {
      const contracts = [
        {
          ...testContract,
          id: 'contract-1',
          title: 'Random Market',
          description: 'Random description',
        },
        {
          ...testContract,
          id: 'contract-2',
          title: 'Fed Rate Decision',
          description: 'Federal Reserve rate decision',
        },
      ];

      mockLLMProvider.generateCompletion = jest
        .fn()
        .mockResolvedValueOnce('Not very relevant')
        .mockResolvedValueOnce('Highly relevant. Direct correlation.');

      const results = await validator.batchValidateContracts(
        contracts,
        testNewsInsight,
        mockLLMProvider,
      );

      // Fed contract should have higher relevance due to entity match
      expect(results[0].contractId).toBe('contract-2');
      expect(results[1].contractId).toBe('contract-1');
    });
  });

  describe('relevance calculation', () => {
    it('should calculate high relevance for matching entities', async () => {
      const result = await validator.validateContract(
        testContract,
        testNewsInsight,
        mockLLMProvider,
      );

      expect(result.relevanceScore).toBeGreaterThan(0.5);
    });

    it('should calculate low relevance for non-matching contract', async () => {
      const unrelatedContract = {
        ...testContract,
        title: 'Bitcoin Price',
        description: 'Will Bitcoin reach $100k?',
      };

      mockLLMProvider.generateCompletion = jest.fn().mockResolvedValue('No relevance found');

      const result = await validator.validateContract(
        unrelatedContract,
        testNewsInsight,
        mockLLMProvider,
      );

      expect(result.relevanceScore).toBeLessThan(0.5);
    });
  });

  describe('confidence calculation', () => {
    it('should calculate confidence based on matches', async () => {
      const result = await validator.validateContract(
        testContract,
        testNewsInsight,
        mockLLMProvider,
      );

      expect(result.suggestedConfidence).toBeGreaterThan(0);
      expect(result.suggestedConfidence).toBeLessThanOrEqual(1);
    });
  });
});
