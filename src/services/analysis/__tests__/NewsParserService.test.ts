import { NewsParserService } from '../NewsParserService';
import { NewsItem, LLMProvider } from '../../../types';

describe('NewsParserService', () => {
  let parser: NewsParserService;
  let mockLLMProvider: LLMProvider;
  let testNewsItem: NewsItem;

  beforeEach(() => {
    parser = new NewsParserService();

    mockLLMProvider = {
      name: 'mock-llm',
      initialize: jest.fn(),
      generateCompletion: jest
        .fn()
        .mockResolvedValue(
          'Federal Reserve rate cut analysis. This is significant and major news. Rally expected.',
        ),
      generateStructuredOutput: jest.fn(),
      isHealthy: jest.fn().mockResolvedValue(true),
      destroy: jest.fn(),
    };

    testNewsItem = {
      id: 'news-1',
      source: 'Test Source',
      title: 'Federal Reserve Announces Rate Cut',
      content: 'The Fed cut rates by 0.5%',
      summary: 'Fed cuts rates',
      url: 'https://example.com/news',
      publishedAt: new Date('2024-01-01'),
      author: 'Test Author',
      tags: ['economy', 'fed', 'rates'],
      metadata: { importance: 'high' },
    };
  });

  describe('parseNews', () => {
    it('should parse a news item and return insights', async () => {
      const result = await parser.parseNews(testNewsItem, mockLLMProvider);

      expect(result).toMatchObject({
        originalNewsId: 'news-1',
        summary: 'Fed cuts rates',
        entities: expect.any(Array),
        events: expect.any(Array),
        predictions: expect.any(Array),
        sentiment: expect.objectContaining({
          overall: expect.any(Number),
          positive: expect.any(Number),
          negative: expect.any(Number),
          neutral: expect.any(Number),
        }),
        relevanceScore: expect.any(Number),
        suggestedActions: expect.any(Array),
      });
    });

    it('should call LLM provider with correct prompt', async () => {
      await parser.parseNews(testNewsItem, mockLLMProvider);

      expect(mockLLMProvider.generateCompletion).toHaveBeenCalledWith(
        expect.stringContaining('Federal Reserve Announces Rate Cut'),
        expect.stringContaining('financial news analyst'),
      );
    });

    it('should extract entities from analysis', async () => {
      const result = await parser.parseNews(testNewsItem, mockLLMProvider);

      const fedEntity = result.entities.find((e) => e.name === 'Federal Reserve');
      expect(fedEntity).toBeDefined();
      expect(fedEntity?.type).toBe('organization');
      expect(fedEntity?.confidence).toBeGreaterThan(0);
    });

    it('should extract events from analysis', async () => {
      const result = await parser.parseNews(testNewsItem, mockLLMProvider);

      const rateEvent = result.events.find((e) => e.type === 'monetary_policy');
      expect(rateEvent).toBeDefined();
      expect(rateEvent?.description).toContain('rate cut');
    });

    it('should calculate sentiment', async () => {
      const result = await parser.parseNews(testNewsItem, mockLLMProvider);

      expect(result.sentiment.overall).toBeDefined();
      expect(result.sentiment.positive).toBeGreaterThanOrEqual(0);
      expect(result.sentiment.positive).toBeLessThanOrEqual(1);
    });

    it('should calculate relevance score', async () => {
      const result = await parser.parseNews(testNewsItem, mockLLMProvider);

      expect(result.relevanceScore).toBeGreaterThan(0.5); // High importance news
      expect(result.relevanceScore).toBeLessThanOrEqual(1);
    });

    it('should suggest actions for Fed news', async () => {
      const result = await parser.parseNews(testNewsItem, mockLLMProvider);

      const betAction = result.suggestedActions.find((a) => a.type === 'bet');
      expect(betAction).toBeDefined();
      expect(betAction?.relatedMarketQuery).toContain('federal reserve');
    });

    it('should use title as summary if summary not provided', async () => {
      const newsWithoutSummary = { ...testNewsItem, summary: undefined };
      const result = await parser.parseNews(newsWithoutSummary, mockLLMProvider);

      expect(result.summary).toBe(testNewsItem.title);
    });
  });

  describe('batchParseNews', () => {
    it('should parse multiple news items', async () => {
      const newsItems = [
        testNewsItem,
        { ...testNewsItem, id: 'news-2', title: 'Tesla Announces Battery Tech' },
      ];

      const results = await parser.batchParseNews(newsItems, mockLLMProvider);

      expect(results).toHaveLength(2);
      expect(results[0].originalNewsId).toBe('news-1');
      expect(results[1].originalNewsId).toBe('news-2');
    });

    it('should handle empty array', async () => {
      const results = await parser.batchParseNews([], mockLLMProvider);
      expect(results).toEqual([]);
    });
  });

  describe('entity extraction', () => {
    it('should extract Tesla entity when mentioned', async () => {
      mockLLMProvider.generateCompletion = jest
        .fn()
        .mockResolvedValue('Tesla battery breakthrough is significant');

      const result = await parser.parseNews(testNewsItem, mockLLMProvider);
      const teslaEntity = result.entities.find((e) => e.name === 'Tesla');

      expect(teslaEntity).toBeDefined();
      expect(teslaEntity?.type).toBe('organization');
    });
  });

  describe('prediction extraction', () => {
    it('should extract rally prediction', async () => {
      mockLLMProvider.generateCompletion = jest
        .fn()
        .mockResolvedValue('Market rally expected following this news');

      const result = await parser.parseNews(testNewsItem, mockLLMProvider);
      const rallyPrediction = result.predictions.find((p) => p.outcome.includes('rally'));

      expect(rallyPrediction).toBeDefined();
      expect(rallyPrediction?.probability).toBeGreaterThan(0);
    });
  });
});
