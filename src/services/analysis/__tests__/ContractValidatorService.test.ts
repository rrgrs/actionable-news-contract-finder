import { ContractValidatorService } from '../ContractValidatorService';
import { Contract, ContractWithContext, ParsedNewsInsight, LLMProvider } from '../../../types';

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
      generateCompletion: jest.fn().mockResolvedValue(
        JSON.stringify({
          isRelevant: true,
          relevanceScore: 0.85,
          matchedEntities: ['Federal Reserve'],
          matchedEvents: ['Federal Reserve rate cut'],
          reasoning: 'This contract is highly relevant to the news. Direct correlation found.',
          suggestedPosition: 'buy',
          confidence: 0.8,
          risks: ['Market volatility'],
          opportunities: ['Rate cut typically bullish for markets'],
        }),
      ),
      generateStructuredOutput: jest.fn(),
      isHealthy: jest.fn().mockResolvedValue(true),
      destroy: jest.fn(),
    };

    testContract = {
      id: 'contract-1',
      title: 'Yes',
      yesPrice: 0.65,
      noPrice: 0.35,
      volume: 100000,
      liquidity: 50000,
      endDate: new Date('2024-03-31'),
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
        'Fed Cuts Rates in Q1',
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
      await validator.validateContract(
        testContract,
        testNewsInsight,
        mockLLMProvider,
        'Fed Cuts Rates in Q1',
      );

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
        'Fed Cuts Rates in Q1',
      );

      expect(result.isRelevant).toBe(true);
      expect(result.relevanceScore).toBeGreaterThan(0.5);
    });

    it('should match entities correctly', async () => {
      const result = await validator.validateContract(
        testContract,
        testNewsInsight,
        mockLLMProvider,
        'Fed Cuts Rates in Q1',
      );

      expect(result.matchedEntities).toContain('Federal Reserve');
    });

    it('should match events correctly', async () => {
      const result = await validator.validateContract(
        testContract,
        testNewsInsight,
        mockLLMProvider,
        'Fed Cuts Rates in Q1',
      );

      expect(result.matchedEvents).toContain('Federal Reserve rate cut');
    });

    it('should suggest position based on sentiment', async () => {
      const result = await validator.validateContract(
        testContract,
        testNewsInsight,
        mockLLMProvider,
        'Fed Cuts Rates in Q1',
      );

      expect(result.suggestedPosition).toBe('buy'); // Positive sentiment + YES outcome
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
        'Fed Cuts Rates in Q1',
      );

      expect(result.suggestedPosition).toBe('hold');
    });
  });

  describe('batchValidateContracts', () => {
    it('should validate multiple contracts with context', async () => {
      const contractsWithContext: ContractWithContext[] = [
        {
          contract: testContract,
          marketTitle: 'Fed Cuts Rates in Q1',
          similarity: 0.85,
        },
        {
          contract: { ...testContract, id: 'contract-2', title: 'No' },
          marketTitle: 'Fed Cuts Rates in Q1',
          similarity: 0.85,
        },
      ];

      // Mock batch response
      mockLLMProvider.generateCompletion = jest.fn().mockResolvedValue(
        JSON.stringify([
          {
            contractId: 'contract-1',
            isRelevant: true,
            relevanceScore: 0.85,
            matchedEntities: ['Federal Reserve'],
            matchedEvents: ['Federal Reserve rate cut'],
            reasoning: 'Directly relevant',
            suggestedPosition: 'buy',
            confidence: 0.8,
            risks: [],
            opportunities: [],
          },
          {
            contractId: 'contract-2',
            isRelevant: true,
            relevanceScore: 0.75,
            matchedEntities: ['Federal Reserve'],
            matchedEvents: [],
            reasoning: 'Related',
            suggestedPosition: 'sell',
            confidence: 0.7,
            risks: [],
            opportunities: [],
          },
        ]),
      );

      const results = await validator.batchValidateContracts(
        contractsWithContext,
        testNewsInsight,
        mockLLMProvider,
      );

      expect(results).toHaveLength(2);
      expect(results[0].contractId).toBeDefined();
      expect(results[1].contractId).toBeDefined();
    });

    it('should sort by relevance score', async () => {
      const contractsWithContext: ContractWithContext[] = [
        {
          contract: { ...testContract, id: 'contract-1', title: 'Yes' },
          marketTitle: 'Random Market',
          similarity: 0.3,
        },
        {
          contract: { ...testContract, id: 'contract-2', title: 'Yes' },
          marketTitle: 'Fed Rate Decision Federal Reserve',
          similarity: 0.9,
        },
      ];

      // Mock batch response with different relevance scores
      mockLLMProvider.generateCompletion = jest.fn().mockResolvedValue(
        JSON.stringify([
          {
            contractId: 'contract-1',
            isRelevant: false,
            relevanceScore: 0.2,
            matchedEntities: [],
            matchedEvents: [],
            reasoning: 'Not relevant',
            suggestedPosition: 'hold',
            confidence: 0.3,
            risks: [],
            opportunities: [],
          },
          {
            contractId: 'contract-2',
            isRelevant: true,
            relevanceScore: 0.9,
            matchedEntities: ['Federal Reserve'],
            matchedEvents: ['Federal Reserve rate cut'],
            reasoning: 'Highly relevant',
            suggestedPosition: 'buy',
            confidence: 0.85,
            risks: [],
            opportunities: [],
          },
        ]),
      );

      const results = await validator.batchValidateContracts(
        contractsWithContext,
        testNewsInsight,
        mockLLMProvider,
      );

      // Fed contract should have higher relevance due to entity match
      expect(results[0].contractId).toBe('contract-2');
      expect(results[1].contractId).toBe('contract-1');
    });

    it('should include similarity in prompt when provided', async () => {
      const contractsWithContext: ContractWithContext[] = [
        {
          contract: testContract,
          marketTitle: 'Fed Cuts Rates in Q1',
          similarity: 0.85,
        },
      ];

      await validator.batchValidateContracts(
        contractsWithContext,
        testNewsInsight,
        mockLLMProvider,
      );

      expect(mockLLMProvider.generateCompletion).toHaveBeenCalledWith(
        expect.stringContaining('85% similar'),
        expect.any(String),
      );
    });
  });

  describe('relevance calculation', () => {
    it('should calculate high relevance for matching entities', async () => {
      const result = await validator.validateContract(
        testContract,
        testNewsInsight,
        mockLLMProvider,
        'Fed Cuts Rates in Q1',
      );

      expect(result.relevanceScore).toBeGreaterThan(0.5);
    });

    it('should calculate low relevance for non-matching contract', async () => {
      const unrelatedContract = {
        ...testContract,
        title: 'Yes',
      };

      mockLLMProvider.generateCompletion = jest.fn().mockResolvedValue(
        JSON.stringify({
          isRelevant: false,
          relevanceScore: 0.1,
          matchedEntities: [],
          matchedEvents: [],
          reasoning: 'No relevance found',
          suggestedPosition: 'hold',
          confidence: 0.2,
          risks: [],
          opportunities: [],
        }),
      );

      const result = await validator.validateContract(
        unrelatedContract,
        testNewsInsight,
        mockLLMProvider,
        'Bitcoin Price',
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
        'Fed Cuts Rates in Q1',
      );

      expect(result.suggestedConfidence).toBeGreaterThan(0);
      expect(result.suggestedConfidence).toBeLessThanOrEqual(1);
    });
  });
});
