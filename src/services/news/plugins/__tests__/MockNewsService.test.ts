import { MockNewsService, MockNewsServicePlugin } from '../MockNewsService';
import { NewsServiceConfig } from '../../../../types';

describe('MockNewsService', () => {
  let service: MockNewsService;
  let config: NewsServiceConfig;

  beforeEach(() => {
    config = {
      name: 'mock-news',
      apiKey: 'test-key',
    };
    service = new MockNewsService(config);
  });

  describe('initialization', () => {
    it('should initialize successfully', async () => {
      await expect(service.initialize(config)).resolves.not.toThrow();
      await expect(service.isHealthy()).resolves.toBe(true);
    });

    it('should set the service name', () => {
      expect(service.name).toBe('mock-news');
    });
  });

  describe('fetchLatestNews', () => {
    it('should fetch mock news items', async () => {
      await service.initialize(config);
      const news = await service.fetchLatestNews();

      expect(news).toBeInstanceOf(Array);
      expect(news.length).toBeGreaterThan(0);

      const firstItem = news[0];
      expect(firstItem).toHaveProperty('id');
      expect(firstItem).toHaveProperty('title');
      expect(firstItem).toHaveProperty('content');
      expect(firstItem).toHaveProperty('publishedAt');
      expect(firstItem.source).toBe('Mock News Service');
    });

    it('should throw error when not initialized', async () => {
      await expect(service.fetchLatestNews()).rejects.toThrow('Service not initialized');
    });

    it('should return news with proper structure', async () => {
      await service.initialize(config);
      const news = await service.fetchLatestNews();

      news.forEach((item) => {
        expect(item).toMatchObject({
          id: expect.any(String),
          source: expect.any(String),
          title: expect.any(String),
          content: expect.any(String),
          url: expect.any(String),
          publishedAt: expect.any(Date),
        });
      });
    });
  });

  describe('searchNews', () => {
    it('should search news by query', async () => {
      await service.initialize(config);
      const results = await service.searchNews('Federal');

      expect(results).toBeInstanceOf(Array);
      expect(results.length).toBeGreaterThan(0);

      results.forEach((item) => {
        const hasMatch =
          item.title.toLowerCase().includes('federal') ||
          item.content.toLowerCase().includes('federal');
        expect(hasMatch).toBe(true);
      });
    });

    it('should return empty array for no matches', async () => {
      await service.initialize(config);
      const results = await service.searchNews('nonexistent-query-xyz');

      expect(results).toBeInstanceOf(Array);
      expect(results.length).toBe(0);
    });

    it('should throw error when not initialized', async () => {
      await expect(service.searchNews('test')).rejects.toThrow('Service not initialized');
    });
  });

  describe('destroy', () => {
    it('should destroy the service', async () => {
      await service.initialize(config);
      await service.destroy();

      await expect(service.isHealthy()).resolves.toBe(false);
    });
  });
});

describe('MockNewsServicePlugin', () => {
  it('should create a MockNewsService instance', () => {
    const config: NewsServiceConfig = {
      name: 'mock-news',
    };

    const service = MockNewsServicePlugin.create(config);

    expect(service).toBeInstanceOf(MockNewsService);
    expect(service.name).toBe('mock-news');
  });
});
