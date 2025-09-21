import axios from 'axios';
import { TwitterNewsService, TwitterNewsServicePlugin } from '../TwitterNewsService';
import { NewsServiceConfig } from '../../../../types';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('TwitterNewsService', () => {
  let service: TwitterNewsService;
  let config: NewsServiceConfig;

  beforeEach(() => {
    jest.clearAllMocks();
    config = {
      name: 'twitter-news',
      customConfig: {
        bearerToken: 'test-bearer-token',
        accounts: 'FirstSquawk,DeItaone',
        keywords: 'BREAKING,URGENT',
        minEngagement: '10',
        maxResults: '25',
      },
    };
    service = new TwitterNewsService();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('initialization', () => {
    it('should initialize with bearer token', async () => {
      await service.initialize(config);
      expect(service.name).toBe('twitter-news');
    });

    it('should work in mock mode without bearer token', async () => {
      const mockConfig: NewsServiceConfig = {
        name: 'twitter-news',
        customConfig: {},
      };
      await service.initialize(mockConfig);
      expect(service.name).toBe('twitter-news');
    });

    it('should use default accounts and keywords when not configured', async () => {
      const defaultConfig: NewsServiceConfig = {
        name: 'twitter-news',
        customConfig: {
          bearerToken: 'test-token',
        },
      };
      await service.initialize(defaultConfig);
      expect(service.name).toBe('twitter-news');
    });
  });

  describe('fetchLatestNews with API', () => {
    beforeEach(async () => {
      await service.initialize(config);
    });

    it('should fetch tweets from followed accounts', async () => {
      // Mock user ID lookup
      mockedAxios.get.mockResolvedValueOnce({
        data: { data: { id: 'user123' } },
      });

      // Mock tweets response
      const mockTweetsResponse = {
        data: {
          data: [
            {
              id: 'tweet123',
              text: 'BREAKING: Federal Reserve announces rate decision',
              created_at: '2024-01-01T12:00:00Z',
              author_id: 'user123',
              public_metrics: {
                like_count: 100,
                retweet_count: 50,
                reply_count: 20,
                quote_count: 10,
              },
              entities: {
                urls: [
                  {
                    url: 'https://t.co/123',
                    expanded_url: 'https://example.com/fed-news',
                    display_url: 'example.com/fed-news',
                  },
                ],
                hashtags: [{ tag: 'FedDecision' }],
              },
            },
          ],
        },
      };

      mockedAxios.get.mockResolvedValueOnce(mockTweetsResponse);

      const news = await service.fetchLatestNews();

      expect(news.length).toBeGreaterThan(0);
      expect(news[0]).toMatchObject({
        id: 'twitter_tweet123',
        source: expect.stringContaining('Twitter'),
        title: expect.any(String),
        content: expect.stringContaining('Federal Reserve'),
        url: 'https://example.com/fed-news',
      });
      expect(news[0].publishedAt).toBeInstanceOf(Date);
      expect(news[0].metadata?.engagement).toBe(150);
    });

    it('should search for keyword-based tweets', async () => {
      const mockSearchResponse = {
        data: {
          data: [
            {
              id: 'tweet456',
              text: 'URGENT: Market crash warning issued',
              created_at: '2024-01-01T13:00:00Z',
              author_id: 'author456',
              public_metrics: {
                like_count: 200,
                retweet_count: 100,
                reply_count: 50,
                quote_count: 25,
              },
            },
          ],
          includes: {
            users: [
              {
                id: 'author456',
                username: 'MarketNews',
                name: 'Market News',
              },
            ],
          },
          meta: {
            result_count: 1,
          },
        },
      };

      // Skip user fetches
      mockedAxios.get.mockImplementation((url) => {
        if (url.includes('/tweets/search/recent')) {
          return Promise.resolve(mockSearchResponse);
        }
        return Promise.reject(new Error('Not found'));
      });

      const news = await service.fetchLatestNews();

      const marketNews = news.find((item) => item.content.includes('Market crash'));
      expect(marketNews).toBeDefined();
      expect(marketNews?.metadata?.importance).toBe('high');
    });

    it('should filter tweets by minimum engagement', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: { data: { id: 'user123' } },
      });

      // Mock getUserId calls for each default account
      mockedAxios.get.mockImplementation((url) => {
        if (url.includes('/users/by/username')) {
          return Promise.resolve({ data: { data: { id: 'test_user_id' } } });
        }

        // Mock user tweets response
        if (url.includes('/users/') && url.includes('/tweets')) {
          return Promise.resolve({
            data: {
              data: [
                {
                  id: 'low_engagement',
                  text: 'Low engagement tweet',
                  created_at: '2024-01-01T12:00:00Z',
                  author_id: 'user123',
                  public_metrics: {
                    like_count: 2,
                    retweet_count: 1,
                    reply_count: 0,
                    quote_count: 0,
                  },
                },
                {
                  id: 'high_engagement',
                  text: 'High engagement tweet',
                  created_at: '2024-01-01T12:00:00Z',
                  author_id: 'user123',
                  public_metrics: {
                    like_count: 100,
                    retweet_count: 50,
                    reply_count: 20,
                    quote_count: 10,
                  },
                },
              ],
            },
          });
        }

        // Mock search tweets response (empty to avoid duplicates)
        if (url.includes('/tweets/search/recent')) {
          return Promise.resolve({ data: { data: [] } });
        }

        return Promise.reject(new Error('Unexpected URL'));
      });

      const news = await service.fetchLatestNews();

      expect(news.length).toBe(1);
      expect(news[0].id).toBe('twitter_high_engagement');
    });

    it('should handle rate limiting', async () => {
      mockedAxios.get.mockRejectedValue({
        isAxiosError: true,
        response: { status: 429 },
      });

      const news = await service.fetchLatestNews();
      expect(news).toEqual([]);
    });
  });

  describe('fetchLatestNews without API (mock mode)', () => {
    it('should return mock news when no bearer token', async () => {
      const mockConfig: NewsServiceConfig = {
        name: 'twitter-news',
        customConfig: {},
      };
      await service.initialize(mockConfig);

      const news = await service.fetchLatestNews();

      expect(news.length).toBeGreaterThan(0);
      expect(news[0].source).toContain('Twitter');
      expect(news[0].tags).toContain('mock');
    });
  });

  describe('searchNews', () => {
    it('should search tweets with query', async () => {
      await service.initialize(config);

      const mockSearchResponse = {
        data: {
          data: [
            {
              id: 'search123',
              text: 'Tesla announces new battery technology',
              created_at: '2024-01-01T14:00:00Z',
              author_id: 'tesla_news',
              public_metrics: {
                like_count: 500,
                retweet_count: 200,
                reply_count: 100,
                quote_count: 50,
              },
            },
          ],
          includes: {
            users: [
              {
                id: 'tesla_news',
                username: 'TeslaNews',
                name: 'Tesla News',
              },
            ],
          },
          meta: {
            result_count: 1,
          },
        },
      };

      mockedAxios.get.mockResolvedValue(mockSearchResponse);

      const results = await service.searchNews('Tesla battery');

      expect(mockedAxios.get).toHaveBeenCalledWith(
        expect.stringContaining('/tweets/search/recent'),
        expect.objectContaining({
          params: expect.objectContaining({
            query: expect.stringContaining('Tesla battery'),
          }),
        }),
      );
      expect(results.length).toBe(1);
      expect(results[0].content).toContain('Tesla');
    });

    it('should return empty array without bearer token', async () => {
      const mockConfig: NewsServiceConfig = {
        name: 'twitter-news',
        customConfig: {},
      };
      await service.initialize(mockConfig);

      const results = await service.searchNews('test');
      expect(results).toEqual([]);
    });
  });

  describe('isHealthy', () => {
    it('should return true in mock mode', async () => {
      const mockConfig: NewsServiceConfig = {
        name: 'twitter-news',
        customConfig: {},
      };
      await service.initialize(mockConfig);

      const isHealthy = await service.isHealthy();
      expect(isHealthy).toBe(true);
    });

    it('should check API health with bearer token', async () => {
      await service.initialize(config);

      mockedAxios.get.mockResolvedValue({ status: 200 });
      const isHealthy = await service.isHealthy();
      expect(isHealthy).toBe(true);
    });

    it('should return false when API is down', async () => {
      await service.initialize(config);

      mockedAxios.get.mockRejectedValue(new Error('API Error'));
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
      expect(service.name).toBe('twitter-news');
    });
  });
});

describe('TwitterNewsServicePlugin', () => {
  it('should create a TwitterNewsService instance', () => {
    const config: NewsServiceConfig = {
      name: 'twitter-news',
    };

    const service = TwitterNewsServicePlugin.create(config);

    expect(service).toBeDefined();
    expect(service.name).toBe('twitter-news');
  });
});
