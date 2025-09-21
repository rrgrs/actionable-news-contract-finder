import axios from 'axios';
import { RedditNewsService, RedditNewsServicePlugin } from '../RedditNewsService';
import { NewsServiceConfig } from '../../../../types';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('RedditNewsService', () => {
  let service: RedditNewsService;
  let config: NewsServiceConfig;

  beforeEach(() => {
    jest.clearAllMocks();
    config = {
      name: 'reddit-news',
      customConfig: {
        subreddits: 'worldnews,news',
        pollInterval: '30000',
        minScore: '10',
        sortBy: 'new',
      },
    };
    service = new RedditNewsService();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('initialization', () => {
    it('should initialize with custom configuration', async () => {
      await service.initialize(config);
      expect(service.name).toBe('reddit-news');
    });

    it('should use default subreddits when not configured', async () => {
      const defaultConfig: NewsServiceConfig = { name: 'reddit-news' };
      await service.initialize(defaultConfig);
      expect(service.name).toBe('reddit-news');
    });
  });

  describe('fetchLatestNews', () => {
    it('should fetch and transform Reddit posts', async () => {
      const mockRedditResponse = {
        data: {
          data: {
            children: [
              {
                data: {
                  id: 'test123',
                  title: 'Breaking: Test News',
                  selftext: 'This is test content',
                  url: 'https://example.com/news',
                  permalink: '/r/news/comments/test123',
                  created_utc: 1700000000,
                  author: 'testuser',
                  subreddit: 'news',
                  score: 100,
                  num_comments: 50,
                  link_flair_text: 'Politics',
                },
              },
            ],
            after: null,
          },
        },
      };

      mockedAxios.get.mockResolvedValue(mockRedditResponse);
      await service.initialize(config);

      const news = await service.fetchLatestNews();

      expect(news).toHaveLength(1);
      expect(news[0]).toMatchObject({
        id: 'reddit_test123',
        source: 'Reddit r/news',
        title: expect.stringContaining('Test News'),
        url: 'https://example.com/news',
        author: 'testuser',
      });
      expect(news[0].publishedAt).toBeInstanceOf(Date);
      expect(news[0].metadata?.score).toBe(100);
    });

    it('should filter posts below minimum score', async () => {
      const mockRedditResponse = {
        data: {
          data: {
            children: [
              {
                data: {
                  id: 'low_score',
                  title: 'Low score post',
                  selftext: '',
                  url: '/r/news/low_score',
                  permalink: '/r/news/comments/low_score',
                  created_utc: 1700000000,
                  author: 'user1',
                  subreddit: 'news',
                  score: 5, // Below threshold of 10
                  num_comments: 2,
                },
              },
              {
                data: {
                  id: 'high_score',
                  title: 'High score post',
                  selftext: '',
                  url: '/r/news/high_score',
                  permalink: '/r/news/comments/high_score',
                  created_utc: 1700000000,
                  author: 'user2',
                  subreddit: 'news',
                  score: 50, // Above threshold
                  num_comments: 20,
                },
              },
            ],
            after: null,
          },
        },
      };

      mockedAxios.get.mockResolvedValue(mockRedditResponse);
      await service.initialize(config);

      const news = await service.fetchLatestNews();

      expect(news).toHaveLength(1);
      expect(news[0].id).toBe('reddit_high_score');
    });

    it('should handle rate limiting gracefully', async () => {
      mockedAxios.get.mockRejectedValue({
        isAxiosError: true,
        response: { status: 429 },
      });

      await service.initialize(config);
      const news = await service.fetchLatestNews();

      expect(news).toEqual([]);
    });

    it('should deduplicate already fetched posts', async () => {
      const mockResponse = {
        data: {
          data: {
            children: [
              {
                data: {
                  id: 'duplicate_post',
                  title: 'Duplicate Post',
                  selftext: 'Content',
                  url: 'https://example.com',
                  permalink: '/r/news/duplicate',
                  created_utc: 1700000000,
                  author: 'user',
                  subreddit: 'news',
                  score: 100,
                  num_comments: 10,
                },
              },
            ],
            after: null,
          },
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
    it('should search Reddit for specific query', async () => {
      const mockSearchResponse = {
        data: {
          data: {
            children: [
              {
                data: {
                  id: 'search_result',
                  title: 'Federal Reserve News',
                  selftext: 'Fed content',
                  url: 'https://example.com/fed',
                  permalink: '/r/economics/fed',
                  created_utc: 1700000000,
                  author: 'econ_user',
                  subreddit: 'economics',
                  score: 200,
                  num_comments: 100,
                },
              },
            ],
            after: null,
          },
        },
      };

      mockedAxios.get.mockResolvedValue(mockSearchResponse);
      await service.initialize(config);

      const results = await service.searchNews('Federal Reserve');

      expect(mockedAxios.get).toHaveBeenCalledWith(
        expect.stringContaining('/search.json'),
        expect.objectContaining({
          params: expect.objectContaining({
            q: 'Federal Reserve',
          }),
        }),
      );
      expect(results).toHaveLength(1);
      expect(results[0].title).toContain('Federal Reserve');
    });

    it('should filter search results by date range', async () => {
      const mockSearchResponse = {
        data: {
          data: {
            children: [
              {
                data: {
                  id: 'old_post',
                  title: 'Old News',
                  selftext: '',
                  url: '/r/news/old',
                  permalink: '/r/news/old',
                  created_utc: 1600000000, // Old timestamp
                  author: 'user',
                  subreddit: 'news',
                  score: 100,
                  num_comments: 10,
                },
              },
              {
                data: {
                  id: 'recent_post',
                  title: 'Recent News',
                  selftext: '',
                  url: '/r/news/recent',
                  permalink: '/r/news/recent',
                  created_utc: 1700000000, // Recent timestamp
                  author: 'user',
                  subreddit: 'news',
                  score: 100,
                  num_comments: 10,
                },
              },
            ],
            after: null,
          },
        },
      };

      mockedAxios.get.mockResolvedValue(mockSearchResponse);
      await service.initialize(config);

      const from = new Date(1650000000000); // Between old and recent
      const results = await service.searchNews('News', from);

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('reddit_recent_post');
    });
  });

  describe('isHealthy', () => {
    it('should return true when Reddit is accessible', async () => {
      mockedAxios.get.mockResolvedValue({ status: 200 });
      await service.initialize(config);

      const isHealthy = await service.isHealthy();
      expect(isHealthy).toBe(true);
    });

    it('should return false when Reddit is not accessible', async () => {
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
      expect(service.name).toBe('reddit-news');
    });
  });
});

describe('RedditNewsServicePlugin', () => {
  it('should create a RedditNewsService instance', () => {
    const config: NewsServiceConfig = {
      name: 'reddit-news',
    };

    const service = RedditNewsServicePlugin.create(config);

    expect(service).toBeDefined();
    expect(service.name).toBe('reddit-news');
  });
});
