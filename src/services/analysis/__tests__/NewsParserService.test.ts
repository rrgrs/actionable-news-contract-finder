import { NewsParserService } from '../NewsParserService';
import { NewsItem, LLMProvider } from '../../../types';

describe('NewsParserService', () => {
  let parser: NewsParserService;
  let mockLLMProvider: LLMProvider;
  let testNewsItem: NewsItem;

  // Mock LLM response with proper JSON structure
  const mockLLMResponse = {
    entities: [
      {
        type: 'organization',
        name: 'Federal Reserve',
        confidence: 0.95,
        context: 'Central banking authority announcing rate changes',
      },
      {
        type: 'person',
        name: 'Jerome Powell',
        confidence: 0.85,
        context: 'Fed Chair making the announcement',
      },
    ],
    events: [
      {
        type: 'economic',
        description: 'Federal Reserve announces 0.5% interest rate cut',
        date: '2024-01-01',
        probability: 1.0,
        impact: 'high',
      },
    ],
    predictions: [
      {
        outcome: 'Stock market rally expected',
        probability: 0.75,
        timeframe: '1-7 days',
        confidence: 0.8,
        reasoning: 'Lower interest rates typically boost equity markets',
      },
      {
        outcome: 'USD weakening against major currencies',
        probability: 0.65,
        timeframe: '1-3 months',
        confidence: 0.7,
        reasoning: 'Rate cuts tend to weaken currency value',
      },
    ],
    sentiment: {
      overall: 0.6,
      positive: 0.7,
      negative: 0.1,
      neutral: 0.2,
    },
    suggestedActions: [
      {
        type: 'bet',
        description: 'Consider positions on Fed rate decision markets',
        urgency: 'high',
        relatedMarketQuery: 'federal reserve interest rate',
        confidence: 0.85,
      },
      {
        type: 'monitor',
        description: 'Track S&P 500 futures for market reaction',
        urgency: 'medium',
        relatedMarketQuery: 'S&P 500 futures',
        confidence: 0.75,
      },
    ],
    relevanceScore: 0.9,
    summary:
      'Federal Reserve cuts rates by 0.5%, signaling dovish monetary policy shift. Markets expected to react positively.',
  };

  beforeEach(() => {
    parser = new NewsParserService();

    mockLLMProvider = {
      name: 'mock-llm',
      initialize: jest.fn(),
      generateCompletion: jest.fn().mockResolvedValue(JSON.stringify(mockLLMResponse)),
      generateStructuredOutput: jest.fn(),
      isHealthy: jest.fn().mockResolvedValue(true),
      destroy: jest.fn(),
    };

    testNewsItem = {
      id: 'news-1',
      source: 'Test Source',
      title: 'Federal Reserve Announces Rate Cut',
      content: 'The Fed cut rates by 0.5% today in a surprise move',
      summary: 'Fed cuts rates',
      url: 'https://example.com/news',
      publishedAt: new Date('2024-01-01'),
      author: 'Test Author',
      tags: ['economy', 'fed', 'rates'],
      metadata: { importance: 'high' },
    };
  });

  describe('parseNews', () => {
    it('should parse a news item and return structured insights', async () => {
      const result = await parser.parseNews(testNewsItem, mockLLMProvider);

      expect(result).toMatchObject({
        originalNewsId: 'news-1',
        summary:
          'Federal Reserve cuts rates by 0.5%, signaling dovish monetary policy shift. Markets expected to react positively.',
        entities: expect.arrayContaining([
          expect.objectContaining({
            type: 'organization',
            name: 'Federal Reserve',
            confidence: 0.95,
          }),
        ]),
        events: expect.arrayContaining([
          expect.objectContaining({
            type: 'economic',
            description: expect.stringContaining('rate cut'),
          }),
        ]),
        predictions: expect.arrayContaining([
          expect.objectContaining({
            outcome: expect.stringContaining('Stock market'),
            probability: expect.any(Number),
          }),
        ]),
        sentiment: expect.objectContaining({
          overall: 0.6,
          positive: 0.7,
          negative: 0.1,
          neutral: 0.2,
        }),
        relevanceScore: 0.9,
        suggestedActions: expect.any(Array),
      });
    });

    it('should call LLM provider with structured JSON prompt', async () => {
      await parser.parseNews(testNewsItem, mockLLMProvider);

      expect(mockLLMProvider.generateCompletion).toHaveBeenCalledWith(
        expect.stringContaining('return a JSON response'),
        expect.stringContaining('advanced news analysis AI'),
      );

      const call = (mockLLMProvider.generateCompletion as jest.Mock).mock.calls[0];
      expect(call[0]).toContain('"entities"');
      expect(call[0]).toContain('"events"');
      expect(call[0]).toContain('"predictions"');
      expect(call[0]).toContain('"sentiment"');
      expect(call[0]).toContain('"suggestedActions"');
    });

    it('should handle JSON response wrapped in markdown code blocks', async () => {
      mockLLMProvider.generateCompletion = jest
        .fn()
        .mockResolvedValue('```json\n' + JSON.stringify(mockLLMResponse) + '\n```');

      const result = await parser.parseNews(testNewsItem, mockLLMProvider);
      expect(result.entities).toHaveLength(2);
      expect(result.entities[0].name).toBe('Federal Reserve');
    });

    it('should handle JSON with extra text before/after', async () => {
      mockLLMProvider.generateCompletion = jest
        .fn()
        .mockResolvedValue(
          'Here is my analysis:\n' +
            JSON.stringify(mockLLMResponse) +
            '\nThat concludes the analysis.',
        );

      const result = await parser.parseNews(testNewsItem, mockLLMProvider);
      expect(result.entities).toHaveLength(2);
    });

    it('should provide fallback analysis when LLM returns invalid JSON', async () => {
      mockLLMProvider.generateCompletion = jest.fn().mockResolvedValue('This is not valid JSON');

      const result = await parser.parseNews(testNewsItem, mockLLMProvider);

      // Should still return a valid insight structure
      expect(result.originalNewsId).toBe('news-1');
      expect(result.summary).toBe('Fed cuts rates');
      expect(result.entities).toEqual([]);
      expect(result.events).toEqual([]);
      expect(result.sentiment).toBeDefined();
      expect(result.relevanceScore).toBe(0.5);
    });

    it('should handle LLM provider errors gracefully', async () => {
      mockLLMProvider.generateCompletion = jest.fn().mockRejectedValue(new Error('LLM API error'));

      const result = await parser.parseNews(testNewsItem, mockLLMProvider);

      // Should return fallback insight
      expect(result.originalNewsId).toBe('news-1');
      expect(result.metadata?.fallbackAnalysis).toBe(true);
    });

    it('should validate and normalize confidence scores', async () => {
      const invalidResponse = {
        ...mockLLMResponse,
        entities: [
          { type: 'organization', name: 'Test Corp', confidence: 1.5 }, // Invalid: > 1
          { type: 'person', name: 'John Doe', confidence: -0.2 }, // Invalid: < 0
        ],
      };

      mockLLMProvider.generateCompletion = jest
        .fn()
        .mockResolvedValue(JSON.stringify(invalidResponse));

      const result = await parser.parseNews(testNewsItem, mockLLMProvider);

      // Should clamp values to valid range
      expect(result.entities[0].confidence).toBe(1);
      expect(result.entities[1].confidence).toBe(0);
    });

    it('should handle missing optional fields gracefully', async () => {
      const minimalResponse = {
        entities: [],
        events: [],
        predictions: [],
        sentiment: { overall: 0, positive: 0, negative: 0, neutral: 1 },
        suggestedActions: [],
        relevanceScore: 0.5,
        summary: '',
      };

      mockLLMProvider.generateCompletion = jest
        .fn()
        .mockResolvedValue(JSON.stringify(minimalResponse));

      const result = await parser.parseNews(testNewsItem, mockLLMProvider);

      expect(result.summary).toBe('Fed cuts rates'); // Falls back to news summary
      expect(result.entities).toEqual([]);
      expect(result.events).toEqual([]);
    });

    it('should include metadata in analysis', async () => {
      const result = await parser.parseNews(testNewsItem, mockLLMProvider);

      expect(result.metadata).toMatchObject({
        processedAt: expect.any(Date),
        source: 'Test Source',
        llmModel: 'mock-llm',
      });
    });
  });

  describe('batchParseNews', () => {
    it('should parse multiple news items in batches', async () => {
      const newsItems = Array.from({ length: 12 }, (_, i) => ({
        ...testNewsItem,
        id: `news-${i + 1}`,
        title: `News Item ${i + 1}`,
      }));

      // Mock batch response - returns an array
      const mockBatchResponse = newsItems.map((item) => ({
        ...mockLLMResponse,
        newsId: item.id,
        summary: `Summary for ${item.title}`,
      }));

      mockLLMProvider.generateCompletion = jest
        .fn()
        .mockResolvedValueOnce(JSON.stringify(mockBatchResponse.slice(0, 5))) // First batch
        .mockResolvedValueOnce(JSON.stringify(mockBatchResponse.slice(5, 10))) // Second batch
        .mockResolvedValueOnce(JSON.stringify(mockBatchResponse.slice(10, 12))); // Third batch

      const results = await parser.batchParseNews(newsItems, mockLLMProvider);

      expect(results).toHaveLength(12);
      expect(results[0].originalNewsId).toBe('news-1');
      expect(results[11].originalNewsId).toBe('news-12');

      // Should process in batches of 5 (12 items = 3 batches)
      expect(mockLLMProvider.generateCompletion).toHaveBeenCalledTimes(3);
    });

    it('should handle empty array', async () => {
      const results = await parser.batchParseNews([], mockLLMProvider);
      expect(results).toEqual([]);
      expect(mockLLMProvider.generateCompletion).not.toHaveBeenCalled();
    });

    it('should handle partial batch failures', async () => {
      const newsItems = [testNewsItem, { ...testNewsItem, id: 'news-2' }];

      let callCount = 0;
      mockLLMProvider.generateCompletion = jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(JSON.stringify(mockLLMResponse));
        }
        return Promise.reject(new Error('API error'));
      });

      const results = await parser.batchParseNews(newsItems, mockLLMProvider);

      expect(results).toHaveLength(2);
      expect(results[0].entities).toHaveLength(2); // Successful parse
      expect(results[1].metadata?.fallbackAnalysis).toBe(true); // Fallback analysis
    });
  });

  describe('fallback analysis', () => {
    it('should perform basic sentiment analysis when LLM fails', async () => {
      mockLLMProvider.generateCompletion = jest.fn().mockRejectedValue(new Error('LLM error'));

      const positiveNews: NewsItem = {
        ...testNewsItem,
        title: 'Stock Market Sees Major Gains',
        content: 'Markets rise on profit growth and success stories',
      };

      const result = await parser.parseNews(positiveNews, mockLLMProvider);

      expect(result.sentiment.positive).toBeGreaterThan(0);
      expect(result.sentiment.overall).toBeGreaterThan(0);
    });

    it('should detect negative sentiment in fallback mode', async () => {
      mockLLMProvider.generateCompletion = jest.fn().mockRejectedValue(new Error('LLM error'));

      const negativeNews: NewsItem = {
        ...testNewsItem,
        title: 'Market Crash Fears',
        content: 'Losses mount as companies fail and deficit grows',
      };

      const result = await parser.parseNews(negativeNews, mockLLMProvider);

      expect(result.sentiment.negative).toBeGreaterThan(0);
      expect(result.sentiment.overall).toBeLessThan(0);
    });
  });

  describe('entity validation', () => {
    it('should filter out invalid entities', async () => {
      const responseWithInvalidEntities = {
        ...mockLLMResponse,
        entities: [
          { type: 'organization', name: 'Valid Corp', confidence: 0.8 },
          { type: 'invalid' }, // Missing name
          { name: 'No Type' }, // Missing type
          null, // Null entry
          { type: 'person', name: 'Valid Person', confidence: 'not a number' }, // Invalid confidence
        ],
      };

      mockLLMProvider.generateCompletion = jest
        .fn()
        .mockResolvedValue(JSON.stringify(responseWithInvalidEntities));

      const result = await parser.parseNews(testNewsItem, mockLLMProvider);

      expect(result.entities).toHaveLength(2); // Only valid entities
      expect(result.entities[0].name).toBe('Valid Corp');
      expect(result.entities[1].name).toBe('Valid Person');
      expect(result.entities[1].confidence).toBe(0.5); // Default for invalid confidence
    });
  });

  describe('event validation', () => {
    it('should handle events with various date formats', async () => {
      const responseWithEvents = {
        ...mockLLMResponse,
        events: [
          {
            type: 'economic',
            description: 'Event with valid date',
            date: '2024-01-15',
            probability: 0.9,
            impact: 'high',
          },
          {
            type: 'political',
            description: 'Event without date',
            probability: 0.7,
            impact: 'medium',
          },
          {
            type: 'business',
            description: 'Event with invalid date',
            date: 'not a date',
            probability: 0.6,
            impact: 'low',
          },
        ],
      };

      mockLLMProvider.generateCompletion = jest
        .fn()
        .mockResolvedValue(JSON.stringify(responseWithEvents));

      const result = await parser.parseNews(testNewsItem, mockLLMProvider);

      expect(result.events).toHaveLength(3);
      expect(result.events[0].date).toEqual(new Date('2024-01-15'));
      expect(result.events[1].date).toBeUndefined();
      expect(result.events[2].date).toBeUndefined(); // Invalid date becomes undefined
    });
  });
});
