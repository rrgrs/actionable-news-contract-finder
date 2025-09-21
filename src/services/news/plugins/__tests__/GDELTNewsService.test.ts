import axios from 'axios';
import { GDELTNewsService, GDELTNewsServicePlugin } from '../GDELTNewsService';
import { NewsServiceConfig } from '../../../../types';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('GDELTNewsService', () => {
  let service: GDELTNewsService;
  let config: NewsServiceConfig;

  beforeEach(() => {
    jest.clearAllMocks();
    config = {
      name: 'gdelt-news',
      customConfig: {
        maxRecords: '100',
        languages: 'english',
        themes: 'ECON_STOCKMARKET,ECON_INTEREST_RATE',
        countries: 'US,GB',
        minTone: '-5',
        maxTone: '5',
      },
    };
    service = new GDELTNewsService();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('initialization', () => {
    it('should initialize with custom configuration', async () => {
      await service.initialize(config);
      expect(service.name).toBe('gdelt-news');
    });

    it('should use default market themes when not configured', async () => {
      const defaultConfig: NewsServiceConfig = { name: 'gdelt-news' };
      await service.initialize(defaultConfig);
      expect(service.name).toBe('gdelt-news');
    });
  });

  describe('fetchLatestNews', () => {
    it('should fetch and transform GDELT articles', async () => {
      const mockGDELTResponse = {
        data: {
          articles: [
            {
              url: 'https://example.com/article1',
              title: 'Federal Reserve Considers Rate Changes',
              seendate: '20240101120000',
              domain: 'example.com',
              language: 'English',
              sourcecountry: 'United States',
              theme: 'ECON_INTEREST_RATE;CENTRAL_BANK',
              tone: -2.5,
              goldsteinscale: 3.2,
              socialimage: 'https://example.com/image.jpg',
            },
            {
              url: 'https://example.com/article2',
              title: 'Stock Market Rally Continues',
              seendate: '20240101110000',
              domain: 'finance.com',
              language: 'English',
              sourcecountry: 'United States',
              theme: 'ECON_STOCKMARKET',
              tone: 5.8,
              goldsteinscale: 7.1,
            },
          ],
          status: 'ok',
        },
      };

      mockedAxios.get.mockResolvedValue(mockGDELTResponse);
      await service.initialize(config);

      const news = await service.fetchLatestNews();

      expect(news).toHaveLength(2);
      expect(news[0]).toMatchObject({
        id: expect.stringContaining('gdelt_'),
        source: 'GDELT - example.com',
        title: 'Federal Reserve Considers Rate Changes',
        url: 'https://example.com/article1',
      });
      expect(news[0].publishedAt).toBeInstanceOf(Date);
      expect(news[0].metadata?.tone).toBe(-2.5);
      expect(news[0].metadata?.importance).toBeDefined();
    });

    it('should filter by configured themes', async () => {
      const mockResponse = {
        data: {
          articles: [
            {
              url: 'https://example.com/relevant',
              title: 'Interest Rate News',
              seendate: '20240101120000',
              domain: 'example.com',
              language: 'English',
              theme: 'ECON_INTEREST_RATE',
              tone: 0,
            },
          ],
          status: 'ok',
        },
      };

      mockedAxios.get.mockResolvedValue(mockResponse);
      await service.initialize(config);

      const news = await service.fetchLatestNews();

      expect(mockedAxios.get).toHaveBeenCalledWith(
        expect.stringContaining('/api/v2/doc/doc'),
        expect.objectContaining({
          params: expect.objectContaining({
            query: expect.stringContaining('ECON_STOCKMARKET'),
          }),
        }),
      );
      expect(news.length).toBeGreaterThan(0);
    });

    it('should handle API errors gracefully', async () => {
      const mockErrorResponse = {
        data: {
          status: 'error',
          message: 'Invalid query',
        },
      };

      mockedAxios.get.mockResolvedValue(mockErrorResponse);
      await service.initialize(config);

      const news = await service.fetchLatestNews();
      expect(news).toEqual([]);
    });

    it('should calculate importance based on tone and keywords', async () => {
      const mockResponse = {
        data: {
          articles: [
            {
              url: 'https://example.com/breaking',
              title: 'BREAKING: Major Market Crash',
              seendate: '20240101120000',
              domain: 'news.com',
              language: 'English',
              tone: -15, // Very negative
              goldsteinscale: -10,
            },
            {
              url: 'https://example.com/normal',
              title: 'Regular Market Update',
              seendate: '20240101120000',
              domain: 'news.com',
              language: 'English',
              tone: 0,
              goldsteinscale: 0,
            },
          ],
          status: 'ok',
        },
      };

      mockedAxios.get.mockResolvedValue(mockResponse);
      await service.initialize(config);

      const news = await service.fetchLatestNews();

      const breakingNews = news.find((item) => item.title.includes('BREAKING'));
      const regularNews = news.find((item) => item.title.includes('Regular'));

      expect(breakingNews?.metadata?.importance).toBe('high');
      expect(regularNews?.metadata?.importance).toBe('low');
    });

    it('should deduplicate processed articles', async () => {
      const mockResponse = {
        data: {
          articles: [
            {
              url: 'https://example.com/duplicate',
              title: 'Duplicate Article',
              seendate: '20240101120000',
              domain: 'example.com',
              language: 'English',
              tone: 0,
            },
          ],
          status: 'ok',
        },
      };

      mockedAxios.get.mockResolvedValue(mockResponse);
      await service.initialize(config);

      const firstFetch = await service.fetchLatestNews();
      expect(firstFetch).toHaveLength(1);

      const secondFetch = await service.fetchLatestNews();
      expect(secondFetch).toHaveLength(0);
    });
  });

  describe('searchNews', () => {
    it('should search with custom query', async () => {
      const mockSearchResponse = {
        data: {
          articles: [
            {
              url: 'https://example.com/tesla',
              title: 'Tesla Announces New Factory',
              seendate: '20240101120000',
              domain: 'auto.com',
              language: 'English',
              theme: 'BUSINESS',
              tone: 3.5,
            },
          ],
          status: 'ok',
        },
      };

      mockedAxios.get.mockResolvedValue(mockSearchResponse);
      await service.initialize(config);

      const results = await service.searchNews('Tesla factory');

      expect(mockedAxios.get).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          params: expect.objectContaining({
            query: 'Tesla factory',
          }),
        }),
      );
      expect(results.length).toBe(1);
      expect(results[0].title).toContain('Tesla');
    });

    it('should add date filters to search query', async () => {
      const mockResponse = {
        data: {
          articles: [],
          status: 'ok',
        },
      };

      mockedAxios.get.mockResolvedValue(mockResponse);
      await service.initialize(config);

      const from = new Date('2024-01-01');
      const to = new Date('2024-01-31');
      await service.searchNews('test', from, to);

      expect(mockedAxios.get).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          params: expect.objectContaining({
            query: expect.stringContaining('timespan:20240101-20240131'),
          }),
        }),
      );
    });
  });

  describe('isHealthy', () => {
    it('should return true when API is accessible', async () => {
      mockedAxios.get.mockResolvedValue({
        status: 200,
        data: { status: 'ok', articles: [] },
      });
      await service.initialize(config);

      const isHealthy = await service.isHealthy();
      expect(isHealthy).toBe(true);
    });

    it('should return false when API returns error', async () => {
      mockedAxios.get.mockResolvedValue({
        status: 200,
        data: { status: 'error' },
      });
      await service.initialize(config);

      const isHealthy = await service.isHealthy();
      expect(isHealthy).toBe(false);
    });

    it('should return false when API is not accessible', async () => {
      mockedAxios.get.mockRejectedValue(new Error('Network error'));
      await service.initialize(config);

      const isHealthy = await service.isHealthy();
      expect(isHealthy).toBe(false);
    });
  });

  describe('destroy', () => {
    it('should clean up resources', async () => {
      await service.initialize(config);
      await service.destroy();

      // Verify service can be reinitialized after destroy
      await service.initialize(config);
      expect(service.name).toBe('gdelt-news');
    });
  });
});

describe('GDELTNewsServicePlugin', () => {
  it('should create a GDELTNewsService instance', () => {
    const config: NewsServiceConfig = {
      name: 'gdelt-news',
    };

    const service = GDELTNewsServicePlugin.create(config);

    expect(service).toBeDefined();
    expect(service.name).toBe('gdelt-news');
  });
});
