import axios from 'axios';
import { FinnhubNewsService, FinnhubNewsServicePlugin } from '../FinnhubNewsService';
import { NewsServiceConfig } from '../../../../types';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('FinnhubNewsService', () => {
  let service: FinnhubNewsService;
  let config: NewsServiceConfig;

  beforeEach(() => {
    jest.clearAllMocks();
    config = {
      name: 'finnhub-news',
      apiKey: 'test-api-key',
      customConfig: {
        categories: 'general', // Only one category to simplify test expectations
        symbols: 'AAPL,MSFT,GOOGL',
        maxItemsPerCategory: '10',
      },
    };
    service = new FinnhubNewsService();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('initialization', () => {
    it('should initialize with API key', async () => {
      await service.initialize(config);
      expect(service.name).toBe('finnhub-news');
    });

    it('should work with demo key when no API key provided', async () => {
      const demoConfig: NewsServiceConfig = {
        name: 'finnhub-news',
      };
      await service.initialize(demoConfig);
      expect(service.name).toBe('finnhub-news');
    });

    it('should use default symbols when not configured', async () => {
      const defaultConfig: NewsServiceConfig = {
        name: 'finnhub-news',
        apiKey: 'test-key',
      };
      await service.initialize(defaultConfig);
      expect(service.name).toBe('finnhub-news');
    });
  });

  describe('fetchLatestNews', () => {
    beforeEach(async () => {
      await service.initialize(config);
    });

    it('should fetch market news by category', async () => {
      const mockMarketNews = [
        {
          category: 'general',
          datetime: 1704110400, // Unix timestamp
          headline: 'Market Opens Strong on Fed Comments',
          id: 123456,
          image: 'https://example.com/image1.jpg',
          related: 'SPY,QQQ',
          source: 'Reuters',
          summary: 'Markets rally on Federal Reserve comments',
          url: 'https://example.com/article1',
        },
        {
          category: 'forex',
          datetime: 1704106800,
          headline: 'EUR/USD Rises on ECB Decision',
          id: 123457,
          image: 'https://example.com/image2.jpg',
          related: 'EURUSD',
          source: 'Bloomberg',
          summary: 'Euro strengthens against dollar',
          url: 'https://example.com/article2',
        },
      ];

      mockedAxios.get.mockResolvedValue({ data: mockMarketNews });

      const news = await service.fetchLatestNews();

      expect(mockedAxios.get).toHaveBeenCalledWith(
        expect.stringContaining('/news'),
        expect.objectContaining({
          params: expect.objectContaining({
            category: expect.any(String),
            token: 'test-api-key',
          }),
        }),
      );

      expect(news.length).toBeGreaterThan(0);
      expect(news[0]).toMatchObject({
        id: expect.stringContaining('finnhub_'),
        source: expect.stringContaining('Finnhub'),
        title: expect.any(String),
        url: expect.any(String),
      });
      expect(news[0].publishedAt).toBeInstanceOf(Date);
    });

    it('should fetch company-specific news', async () => {
      const mockCompanyNews = [
        {
          category: 'company',
          datetime: 1704110400,
          headline: 'Apple Announces New Product Line',
          id: 789012,
          image: 'https://example.com/apple.jpg',
          related: 'AAPL',
          source: 'TechCrunch',
          summary: 'Apple unveils new products',
          url: 'https://example.com/apple-news',
        },
      ];

      // Mock market news as empty
      mockedAxios.get.mockImplementation((url) => {
        if (url.includes('/company-news')) {
          return Promise.resolve({ data: mockCompanyNews });
        }
        return Promise.resolve({ data: [] });
      });

      const news = await service.fetchLatestNews();

      expect(mockedAxios.get).toHaveBeenCalledWith(
        expect.stringContaining('/company-news'),
        expect.objectContaining({
          params: expect.objectContaining({
            symbol: expect.any(String),
            token: 'test-api-key',
          }),
        }),
      );

      const appleNews = news.find((item) => item.title.includes('AAPL'));
      expect(appleNews).toBeDefined();
      expect(appleNews?.metadata?.symbol).toBe('AAPL');
    });

    it('should handle rate limiting gracefully', async () => {
      mockedAxios.get.mockRejectedValue({
        isAxiosError: true,
        response: { status: 429 },
      });

      const news = await service.fetchLatestNews();
      expect(news).toBeDefined();
      expect(Array.isArray(news)).toBe(true);
    });

    it('should calculate importance based on keywords', async () => {
      const mockNews = [
        {
          category: 'general',
          datetime: 1704110400,
          headline: 'BREAKING: Federal Reserve Emergency Meeting',
          id: 111,
          source: 'Reuters',
          summary: 'Fed calls emergency meeting',
          url: 'https://example.com/fed',
        },
        {
          category: 'general',
          datetime: 1704110400,
          headline: 'Company Q3 Results Published',
          id: 222,
          source: 'PR Newswire',
          summary: 'Quarterly results published',
          url: 'https://example.com/q3',
        },
      ];

      mockedAxios.get.mockResolvedValue({ data: mockNews });

      const news = await service.fetchLatestNews();

      const breakingNews = news.find((item) => item.title.includes('BREAKING'));
      const regularNews = news.find((item) => item.title.includes('Q3 Results'));

      expect(breakingNews?.metadata?.importance).toBe('high');
      expect(regularNews?.metadata?.importance).toBe('low');
    });

    it('should deduplicate already processed news', async () => {
      const mockNews = [
        {
          category: 'general',
          datetime: 1704110400,
          headline: 'Duplicate News Item',
          id: 999,
          source: 'Reuters',
          summary: 'This is duplicate',
          url: 'https://example.com/dup',
        },
      ];

      mockedAxios.get.mockResolvedValue({ data: mockNews });

      const firstFetch = await service.fetchLatestNews();
      expect(firstFetch.length).toBeGreaterThan(0);

      // Second fetch should filter out duplicates
      const secondFetch = await service.fetchLatestNews();
      const duplicates = secondFetch.filter((item) => item.title.includes('Duplicate News Item'));
      expect(duplicates).toHaveLength(0);
    });
  });

  describe('searchNews', () => {
    it('should filter fetched news by query', async () => {
      const mockNews = [
        {
          category: 'general',
          datetime: 1704110400,
          headline: 'Tesla Reports Strong Sales',
          id: 333,
          source: 'CNBC',
          summary: 'Tesla beats expectations',
          url: 'https://example.com/tesla',
        },
        {
          category: 'general',
          datetime: 1704110400,
          headline: 'Apple Updates iOS',
          id: 444,
          source: 'MacRumors',
          summary: 'iOS update released',
          url: 'https://example.com/apple',
        },
      ];

      // Mock both market news and company news endpoints
      mockedAxios.get.mockImplementation((url) => {
        if (url.includes('/news')) {
          return Promise.resolve({ data: mockNews });
        }
        if (url.includes('/company-news')) {
          return Promise.resolve({ data: [] }); // No company news
        }
        return Promise.reject(new Error('Unexpected URL'));
      });
      await service.initialize(config);

      const results = await service.searchNews('Tesla');

      expect(results).toHaveLength(1);
      expect(results[0].title).toContain('Tesla');
    });

    it('should filter by date range', async () => {
      const mockNews = [
        {
          category: 'general',
          datetime: 1704110400, // Jan 1, 2024
          headline: 'Recent News',
          id: 555,
          source: 'Reuters',
          summary: 'Recent article',
          url: 'https://example.com/recent',
        },
        {
          category: 'general',
          datetime: 1672574400, // Jan 1, 2023
          headline: 'Old News',
          id: 666,
          source: 'Reuters',
          summary: 'Old article',
          url: 'https://example.com/old',
        },
      ];

      // Mock both market news and company news endpoints
      mockedAxios.get.mockImplementation((url) => {
        if (url.includes('/news')) {
          return Promise.resolve({ data: mockNews });
        }
        if (url.includes('/company-news')) {
          return Promise.resolve({ data: [] }); // No company news
        }
        return Promise.reject(new Error('Unexpected URL'));
      });
      await service.initialize(config);

      const from = new Date('2023-12-01');
      const results = await service.searchNews('News', from);

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Recent News');
    });
  });

  describe('isHealthy', () => {
    it('should return true when API is accessible', async () => {
      mockedAxios.get.mockResolvedValue({
        status: 200,
        data: [],
      });
      await service.initialize(config);

      const isHealthy = await service.isHealthy();
      expect(isHealthy).toBe(true);
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
      expect(service.name).toBe('finnhub-news');
    });
  });
});

describe('FinnhubNewsServicePlugin', () => {
  it('should create a FinnhubNewsService instance', () => {
    const config: NewsServiceConfig = {
      name: 'finnhub-news',
    };

    const service = FinnhubNewsServicePlugin.create(config);

    expect(service).toBeDefined();
    expect(service.name).toBe('finnhub-news');
  });
});
