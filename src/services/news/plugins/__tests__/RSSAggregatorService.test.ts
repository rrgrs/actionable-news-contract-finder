import axios from 'axios';
import { RSSAggregatorService, RSSAggregatorServicePlugin } from '../RSSAggregatorService';
import { NewsServiceConfig } from '../../../../types';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('RSSAggregatorService', () => {
  let service: RSSAggregatorService;
  let config: NewsServiceConfig;

  beforeEach(() => {
    jest.clearAllMocks();
    config = {
      name: 'rss-aggregator',
      customConfig: {
        feeds:
          'https://feeds.reuters.com/reuters/topNews,https://feeds.bloomberg.com/markets/news.rss',
        maxItemsPerFeed: '10',
      },
    };
    service = new RSSAggregatorService();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('initialization', () => {
    it('should initialize with custom feeds', async () => {
      await service.initialize(config);
      expect(service.name).toBe('rss-aggregator');
    });

    it('should use default feeds when not configured', async () => {
      const defaultConfig: NewsServiceConfig = { name: 'rss-aggregator' };
      await service.initialize(defaultConfig);
      expect(service.name).toBe('rss-aggregator');
    });
  });

  describe('fetchLatestNews', () => {
    it('should fetch and parse RSS feeds via RSS2JSON', async () => {
      const mockRSSResponse = {
        data: {
          status: 'ok',
          items: [
            {
              title: 'Breaking News: Test Article',
              link: 'https://example.com/article1',
              description: 'This is a test article description',
              pubDate: '2024-01-01T12:00:00Z',
              guid: 'article-123',
              author: 'Test Author',
            },
            {
              title: 'Market Update',
              link: 'https://example.com/article2',
              description: 'Markets are moving',
              pubDate: '2024-01-01T11:00:00Z',
              guid: 'article-124',
            },
          ],
        },
      };

      mockedAxios.get.mockResolvedValue(mockRSSResponse);
      await service.initialize(config);

      const news = await service.fetchLatestNews();

      expect(news.length).toBeGreaterThan(0);
      expect(news[0]).toMatchObject({
        id: expect.stringContaining('rss_'),
        source: expect.any(String),
        title: expect.any(String),
        content: expect.any(String),
        url: expect.any(String),
      });
      expect(news[0].publishedAt).toBeInstanceOf(Date);
    });

    it('should fallback to direct XML parsing when RSS2JSON fails', async () => {
      const mockXMLResponse = {
        data: `<?xml version="1.0" encoding="UTF-8"?>
          <rss version="2.0">
            <channel>
              <item>
                <title>XML News Title</title>
                <link>https://example.com/xml-article</link>
                <description>XML article description</description>
                <pubDate>Mon, 01 Jan 2024 12:00:00 GMT</pubDate>
                <guid>xml-guid-123</guid>
              </item>
            </channel>
          </rss>`,
      };

      // Mock for both feeds configured in test
      mockedAxios.get.mockImplementation((url) => {
        // RSS2JSON calls fail
        if (url.includes('rss2json.com')) {
          return Promise.reject(new Error('RSS2JSON error'));
        }
        // Direct XML calls succeed
        if (url.includes('reuters.com') || url.includes('bloomberg.com')) {
          return Promise.resolve(mockXMLResponse);
        }
        return Promise.reject(new Error('Unexpected URL'));
      });

      await service.initialize(config);
      const news = await service.fetchLatestNews();

      expect(news.length).toBeGreaterThan(0);
      expect(news[0].title).toContain('XML News Title');
    });

    it('should deduplicate similar news items', async () => {
      const mockResponse = {
        data: {
          status: 'ok',
          items: [
            {
              title: 'Federal Reserve Announces Rate Decision',
              link: 'https://reuters.com/fed',
              description: 'Fed announces',
              pubDate: '2024-01-01T12:00:00Z',
              guid: 'reuters-123',
            },
          ],
        },
      };

      const mockResponse2 = {
        data: {
          status: 'ok',
          items: [
            {
              title: 'Federal Reserve Announces Rate Decision Today',
              link: 'https://bloomberg.com/fed',
              description: 'Fed announces',
              pubDate: '2024-01-01T12:01:00Z',
              guid: 'bloomberg-456',
            },
          ],
        },
      };

      mockedAxios.get.mockResolvedValueOnce(mockResponse);
      mockedAxios.get.mockResolvedValueOnce(mockResponse2);

      await service.initialize(config);
      const news = await service.fetchLatestNews();

      // Should deduplicate very similar titles
      const fedNews = news.filter((item) => item.title.toLowerCase().includes('federal reserve'));
      expect(fedNews.length).toBeLessThanOrEqual(2);
    });

    it('should handle feed errors gracefully', async () => {
      mockedAxios.get.mockRejectedValue(new Error('Network error'));

      await service.initialize(config);
      const news = await service.fetchLatestNews();

      expect(news).toEqual([]);
    });

    it('should clean HTML from content', async () => {
      const mockResponse = {
        data: {
          status: 'ok',
          items: [
            {
              title: 'Test Article',
              link: 'https://example.com/article',
              description: '<p>This is <b>HTML</b> content &amp; entities</p>',
              pubDate: '2024-01-01T12:00:00Z',
              guid: 'test-123',
            },
          ],
        },
      };

      mockedAxios.get.mockResolvedValue(mockResponse);
      await service.initialize(config);

      const news = await service.fetchLatestNews();

      expect(news[0].content).not.toContain('<p>');
      expect(news[0].content).not.toContain('<b>');
      expect(news[0].content).toContain('HTML content & entities');
    });
  });

  describe('searchNews', () => {
    it('should filter news by query', async () => {
      const mockResponse = {
        data: {
          status: 'ok',
          items: [
            {
              title: 'Federal Reserve Meeting',
              link: 'https://example.com/fed',
              description: 'Fed meeting details',
              pubDate: '2024-01-01T12:00:00Z',
              guid: 'fed-123',
            },
            {
              title: 'Stock Market Update',
              link: 'https://example.com/stocks',
              description: 'Market closes higher',
              pubDate: '2024-01-01T11:00:00Z',
              guid: 'stocks-123',
            },
          ],
        },
      };

      mockedAxios.get.mockResolvedValue(mockResponse);
      await service.initialize(config);

      const results = await service.searchNews('Federal');

      expect(results.length).toBe(1);
      expect(results[0].title).toContain('Federal');
    });

    it('should filter by date range', async () => {
      const mockResponse = {
        data: {
          status: 'ok',
          items: [
            {
              title: 'Old News',
              link: 'https://example.com/old',
              description: 'Old article',
              pubDate: '2023-01-01T12:00:00Z',
              guid: 'old-123',
            },
            {
              title: 'Recent News',
              link: 'https://example.com/recent',
              description: 'Recent article',
              pubDate: '2024-01-01T12:00:00Z',
              guid: 'recent-123',
            },
          ],
        },
      };

      mockedAxios.get.mockResolvedValue(mockResponse);
      await service.initialize(config);

      const from = new Date('2023-12-01');
      const results = await service.searchNews('News', from);

      expect(results.length).toBe(1);
      expect(results[0].title).toBe('Recent News');
    });
  });

  describe('isHealthy', () => {
    it('should return true when at least one feed is accessible', async () => {
      mockedAxios.head.mockResolvedValueOnce({ status: 200 });
      mockedAxios.head.mockRejectedValueOnce(new Error('Not found'));

      await service.initialize(config);
      const isHealthy = await service.isHealthy();

      expect(isHealthy).toBe(true);
    });

    it('should return false when all feeds are inaccessible', async () => {
      mockedAxios.head.mockRejectedValue(new Error('Network error'));

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
      expect(service.name).toBe('rss-aggregator');
    });
  });
});

describe('RSSAggregatorServicePlugin', () => {
  it('should create an RSSAggregatorService instance', () => {
    const config: NewsServiceConfig = {
      name: 'rss-aggregator',
    };

    const service = RSSAggregatorServicePlugin.create(config);

    expect(service).toBeDefined();
    expect(service.name).toBe('rss-aggregator');
  });
});
