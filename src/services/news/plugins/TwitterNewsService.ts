import axios from 'axios';
import { NewsService, NewsServiceConfig, NewsItem, NewsServicePlugin } from '../../../types';
import { RateLimiter, withRateLimit } from '../../../utils/rateLimiter';
import { createLogger, Logger } from '../../../utils/logger';

interface TwitterUser {
  id: string;
  username: string;
  name: string;
}

interface Tweet {
  id: string;
  text: string;
  created_at: string;
  author_id: string;
  entities?: {
    urls?: Array<{
      url: string;
      expanded_url: string;
      display_url: string;
    }>;
    hashtags?: Array<{
      tag: string;
    }>;
    mentions?: Array<{
      username: string;
    }>;
  };
  public_metrics?: {
    retweet_count: number;
    reply_count: number;
    like_count: number;
    quote_count: number;
  };
  referenced_tweets?: Array<{
    type: 'retweeted' | 'quoted' | 'replied_to';
    id: string;
  }>;
}

interface TwitterResponse {
  data: Tweet[];
  includes?: {
    users?: TwitterUser[];
  };
  meta: {
    result_count: number;
    next_token?: string;
  };
}

export class TwitterNewsService implements NewsService {
  name = 'twitter-news';
  private bearerToken: string = '';
  private baseUrl = 'https://api.twitter.com/2';
  private processedTweetIds = new Set<string>();
  private followedAccounts: string[] = [];
  private searchKeywords: string[] = [];
  private maxResults = 10;
  private minEngagement = 10;
  private rateLimiter!: RateLimiter;
  private logger: Logger;

  private readonly defaultAccounts = [
    'FirstSquawk',
    'DeItaone',
    'unusual_whales',
    'zerohedge',
    'Reuters',
    'AP',
    'BBCBreaking',
    'CNBCnow',
    'WSJ',
    'FT',
    'business',
    'ForexLive',
    'LiveSquawk',
    'MarketWatch',
  ];

  private readonly defaultKeywords = [
    'BREAKING',
    'URGENT',
    'JUST IN',
    'Federal Reserve',
    'interest rate',
    'inflation',
    'earnings beat',
    'earnings miss',
    'merger',
    'acquisition',
    'IPO',
    'bankruptcy',
    'default',
    'GDP',
    'unemployment',
    'jobs report',
    'stimulus',
    'bailout',
    'sanctions',
    'trade war',
    'tariff',
  ];

  constructor() {
    this.logger = createLogger('Twitter');
  }

  async initialize(config: NewsServiceConfig): Promise<void> {
    const customConfig = config.customConfig as Record<string, string> | undefined;

    this.bearerToken = customConfig?.bearerToken || process.env.TWITTER_BEARER_TOKEN || '';

    if (!this.bearerToken) {
      this.logger.warn('Bearer Token not provided, using mock data mode');
    }

    // Initialize rate limiter (Twitter API v2: 15 requests/15 minutes = 1 req/min)
    this.rateLimiter = new RateLimiter(
      {
        minDelayMs: 5000,
        requestsPerMinute: 15,
        maxRetries: 3,
        baseBackoffMs: 60000,
      },
      'Twitter',
    );

    if (customConfig?.accounts) {
      this.followedAccounts = customConfig.accounts.split(',').map((a: string) => a.trim());
    } else {
      this.followedAccounts = [...this.defaultAccounts];
    }

    if (customConfig?.keywords) {
      this.searchKeywords = customConfig.keywords.split(',').map((k: string) => k.trim());
    } else {
      this.searchKeywords = [...this.defaultKeywords];
    }

    if (customConfig?.maxResults) {
      this.maxResults = parseInt(customConfig.maxResults);
    }

    if (customConfig?.minEngagement) {
      this.minEngagement = parseInt(customConfig.minEngagement);
    }

    this.logger.info('Service initialized', {
      accountsCount: this.followedAccounts.length,
      keywordsCount: this.searchKeywords.length,
    });
  }

  async fetchLatestNews(): Promise<NewsItem[]> {
    if (!this.bearerToken) {
      return this.getMockNews();
    }

    const allNews: NewsItem[] = [];

    for (const account of this.followedAccounts) {
      try {
        const tweets = await this.fetchUserTweets(account);
        allNews.push(...tweets);
      } catch (error) {
        this.logger.error('Failed to fetch tweets from account', {
          account,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    try {
      const keywordTweets = await this.searchTweets();
      allNews.push(...keywordTweets);
    } catch (error) {
      this.logger.error('Failed to search tweets', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const uniqueNews = this.deduplicateNews(allNews);
    uniqueNews.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());

    if (this.processedTweetIds.size > 1000) {
      const idsArray = Array.from(this.processedTweetIds);
      this.processedTweetIds = new Set(idsArray.slice(-500));
    }

    return uniqueNews;
  }

  private async fetchUserTweets(username: string): Promise<NewsItem[]> {
    try {
      const userId = await this.getUserId(username);
      if (!userId) {
        this.logger.warn('Could not find user ID', { username });
        return [];
      }

      const url = `${this.baseUrl}/users/${userId}/tweets`;
      const response = await withRateLimit(this.rateLimiter, () =>
        axios.get<TwitterResponse>(url, {
          headers: {
            Authorization: `Bearer ${this.bearerToken}`,
          },
          params: {
            max_results: this.maxResults,
            'tweet.fields': 'created_at,public_metrics,entities,referenced_tweets',
            exclude: 'retweets,replies',
          },
        }),
      );

      return this.transformTweets(response.data.data || [], username);
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 429) {
        this.logger.warn('Rate limited', { username });
      }
      return [];
    }
  }

  private async searchTweets(): Promise<NewsItem[]> {
    try {
      const query = this.buildSearchQuery();

      const url = `${this.baseUrl}/tweets/search/recent`;
      const response = await withRateLimit(this.rateLimiter, () =>
        axios.get<TwitterResponse>(url, {
          headers: {
            Authorization: `Bearer ${this.bearerToken}`,
          },
          params: {
            query: query,
            max_results: this.maxResults * 2,
            'tweet.fields': 'created_at,public_metrics,entities,author_id',
            'user.fields': 'username,name',
            expansions: 'author_id',
          },
        }),
      );

      const tweets = response.data.data || [];
      const users = response.data.includes?.users || [];

      const userMap = new Map(users.map((u) => [u.id, u]));

      return this.transformTweets(tweets, undefined, userMap);
    } catch (error) {
      this.logger.error('Twitter search failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  private buildSearchQuery(): string {
    const keywordQuery = this.searchKeywords.map((k) => `"${k}"`).join(' OR ');

    const filters = ['-is:retweet', '-is:reply', 'lang:en', 'has:links OR has:media'].join(' ');

    return `(${keywordQuery}) ${filters}`;
  }

  private async getUserId(username: string): Promise<string | null> {
    try {
      const url = `${this.baseUrl}/users/by/username/${username}`;
      const response = await withRateLimit(this.rateLimiter, () =>
        axios.get(url, {
          headers: {
            Authorization: `Bearer ${this.bearerToken}`,
          },
        }),
      );
      return response.data.data?.id || null;
    } catch {
      return null;
    }
  }

  private transformTweets(
    tweets: Tweet[],
    defaultAuthor?: string,
    userMap?: Map<string, TwitterUser>,
  ): NewsItem[] {
    const newsItems: NewsItem[] = [];

    for (const tweet of tweets) {
      if (this.processedTweetIds.has(tweet.id)) {
        continue;
      }

      const engagement =
        (tweet.public_metrics?.like_count || 0) + (tweet.public_metrics?.retweet_count || 0);
      if (engagement < this.minEngagement) {
        continue;
      }

      this.processedTweetIds.add(tweet.id);

      let author = defaultAuthor || 'Twitter';
      if (userMap && tweet.author_id) {
        const user = userMap.get(tweet.author_id);
        if (user) {
          author = user.username;
        }
      }

      const urls = tweet.entities?.urls || [];
      const primaryUrl =
        urls.length > 0 ? urls[0].expanded_url : `https://twitter.com/${author}/status/${tweet.id}`;

      const newsItem: NewsItem = {
        id: `twitter_${tweet.id}`,
        source: `Twitter @${author}`,
        title: this.extractTitle(tweet.text),
        content: tweet.text,
        summary: tweet.text.substring(0, 200),
        url: primaryUrl,
        publishedAt: new Date(tweet.created_at),
        author: `@${author}`,
        tags: this.extractTags(tweet),
        metadata: {
          tweetId: tweet.id,
          tweetUrl: `https://twitter.com/${author}/status/${tweet.id}`,
          likes: tweet.public_metrics?.like_count || 0,
          retweets: tweet.public_metrics?.retweet_count || 0,
          replies: tweet.public_metrics?.reply_count || 0,
          engagement: engagement,
          importance: this.calculateImportance(tweet, engagement),
        },
      };

      newsItems.push(newsItem);
    }

    return newsItems;
  }

  private extractTitle(text: string): string {
    const lines = text.split('\n');
    let title = lines[0];

    title = title.replace(/^(BREAKING|URGENT|JUST IN|UPDATE):?\s*/i, '');

    if (title.length > 100) {
      title = title.substring(0, 97) + '...';
    }

    return title;
  }

  private extractTags(tweet: Tweet): string[] {
    const tags: string[] = ['twitter'];

    if (tweet.entities?.hashtags) {
      tags.push(...tweet.entities.hashtags.map((h) => h.tag.toLowerCase()));
    }

    const text = tweet.text.toLowerCase();
    const keywords = [
      'breaking',
      'urgent',
      'alert',
      'fed',
      'inflation',
      'rate',
      'earnings',
      'ipo',
      'merger',
      'bitcoin',
      'crypto',
      'stock',
    ];

    for (const keyword of keywords) {
      if (text.includes(keyword)) {
        tags.push(keyword);
      }
    }

    return [...new Set(tags)];
  }

  private calculateImportance(tweet: Tweet, engagement: number): 'low' | 'medium' | 'high' {
    const text = tweet.text.toUpperCase();

    if (text.includes('BREAKING') || text.includes('URGENT') || engagement > 1000) {
      return 'high';
    }

    if (text.includes('UPDATE') || text.includes('ALERT') || engagement > 100) {
      return 'medium';
    }

    return 'low';
  }

  private deduplicateNews(items: NewsItem[]): NewsItem[] {
    const seen = new Set<string>();
    return items.filter((item) => {
      const key = (item.metadata?.tweetId as string) || item.id;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  async searchNews(query: string, from?: Date, to?: Date): Promise<NewsItem[]> {
    if (!this.bearerToken) {
      return [];
    }

    try {
      let searchQuery = query;

      if (from) {
        searchQuery += ` since:${from.toISOString().split('T')[0]}`;
      }
      if (to) {
        searchQuery += ` until:${to.toISOString().split('T')[0]}`;
      }

      const url = `${this.baseUrl}/tweets/search/recent`;
      const response = await withRateLimit(this.rateLimiter, () =>
        axios.get<TwitterResponse>(url, {
          headers: {
            Authorization: `Bearer ${this.bearerToken}`,
          },
          params: {
            query: searchQuery + ' -is:retweet -is:reply',
            max_results: 50,
            'tweet.fields': 'created_at,public_metrics,entities,author_id',
            'user.fields': 'username',
            expansions: 'author_id',
          },
        }),
      );

      const users = response.data.includes?.users || [];
      const userMap = new Map(users.map((u) => [u.id, u]));

      return this.transformTweets(response.data.data || [], undefined, userMap);
    } catch (error) {
      this.logger.error('Twitter search failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  private getMockNews(): NewsItem[] {
    const mockTweets = [
      {
        id: 'mock_1',
        text: 'BREAKING: Federal Reserve signals potential rate cuts in Q2 2024 as inflation shows signs of cooling',
        created_at: new Date().toISOString(),
        author: 'FirstSquawk',
        engagement: 500,
      },
      {
        id: 'mock_2',
        text: 'URGENT: Tesla announces breakthrough in battery technology, stock surges 15% in pre-market',
        created_at: new Date(Date.now() - 3600000).toISOString(),
        author: 'DeItaone',
        engagement: 300,
      },
    ];

    return mockTweets.map((tweet) => ({
      id: `twitter_${tweet.id}`,
      source: `Twitter @${tweet.author}`,
      title: tweet.text.substring(0, 100),
      content: tweet.text,
      summary: tweet.text,
      url: `https://twitter.com/${tweet.author}/status/${tweet.id}`,
      publishedAt: new Date(tweet.created_at),
      author: `@${tweet.author}`,
      tags: ['twitter', 'mock'],
      metadata: {
        tweetId: tweet.id,
        engagement: tweet.engagement,
        importance: 'high',
      },
    }));
  }

  async isHealthy(): Promise<boolean> {
    if (!this.bearerToken) {
      return true;
    }

    try {
      const response = await axios.get(`${this.baseUrl}/tweets/search/recent`, {
        headers: {
          Authorization: `Bearer ${this.bearerToken}`,
        },
        params: {
          query: 'news',
          max_results: 10,
        },
        timeout: 5000,
      });
      return response.status === 200;
    } catch {
      return false;
    }
  }

  async destroy(): Promise<void> {
    this.processedTweetIds.clear();
    this.logger.info('Service destroyed');
  }
}

export const TwitterNewsServicePlugin: NewsServicePlugin = {
  create: (_config: NewsServiceConfig) => {
    const service = new TwitterNewsService();
    return service;
  },
};
