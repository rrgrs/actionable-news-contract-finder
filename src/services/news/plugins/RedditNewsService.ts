import axios from 'axios';
import { NewsService, NewsServiceConfig, NewsItem, NewsServicePlugin } from '../../../types';

interface RedditPost {
  data: {
    id: string;
    title: string;
    selftext: string;
    url: string;
    permalink: string;
    created_utc: number;
    author: string;
    subreddit: string;
    score: number;
    num_comments: number;
    link_flair_text?: string;
  };
}

interface RedditResponse {
  data: {
    children: RedditPost[];
    after: string | null;
  };
}

export class RedditNewsService implements NewsService {
  name = 'reddit-news';
  private subreddits: string[] = ['worldnews', 'news', 'economics', 'finance'];
  private userAgent = 'Actionable-News-Bot/1.0';
  private baseUrl = 'https://www.reddit.com';
  private lastFetchedIds = new Set<string>();
  private pollInterval = 30000; // 30 seconds default
  private minScore = 10; // Minimum upvotes to consider
  private sortBy: 'new' | 'hot' | 'rising' = 'new';

  async initialize(config: NewsServiceConfig): Promise<void> {
    const customConfig = config.customConfig as Record<string, string> | undefined;

    if (customConfig?.subreddits) {
      this.subreddits = customConfig.subreddits.split(',').map((s: string) => s.trim());
    }
    if (customConfig?.pollInterval) {
      this.pollInterval = parseInt(customConfig.pollInterval);
    }
    if (customConfig?.minScore) {
      this.minScore = parseInt(customConfig.minScore);
    }
    if (customConfig?.sortBy) {
      this.sortBy = customConfig.sortBy as 'new' | 'hot' | 'rising';
    }

    console.log(`Reddit News Service initialized with subreddits: ${this.subreddits.join(', ')}`);
    console.log(
      `Poll interval: ${this.pollInterval}ms, Min score: ${this.minScore}, Sort: ${this.sortBy}`,
    );
  }

  async fetchLatestNews(): Promise<NewsItem[]> {
    const allNews: NewsItem[] = [];

    for (const subreddit of this.subreddits) {
      try {
        const news = await this.fetchFromSubreddit(subreddit);
        allNews.push(...news);
      } catch (error) {
        console.error(`Error fetching from r/${subreddit}:`, error);
      }
    }

    // Sort by publication time (newest first)
    allNews.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());

    // Clean up old IDs to prevent memory leak
    if (this.lastFetchedIds.size > 1000) {
      const idsArray = Array.from(this.lastFetchedIds);
      this.lastFetchedIds = new Set(idsArray.slice(-500));
    }

    return allNews;
  }

  private async fetchFromSubreddit(subreddit: string): Promise<NewsItem[]> {
    const url = `${this.baseUrl}/r/${subreddit}/${this.sortBy}.json`;

    try {
      const response = await axios.get<RedditResponse>(url, {
        headers: {
          'User-Agent': this.userAgent,
        },
        params: {
          limit: 25,
          raw_json: 1,
        },
      });

      const posts = response.data.data.children;
      const newsItems: NewsItem[] = [];

      for (const post of posts) {
        const postData = post.data;

        // Filter by score and check if already processed
        if (postData.score < this.minScore || this.lastFetchedIds.has(postData.id)) {
          continue;
        }

        // Mark as processed
        this.lastFetchedIds.add(postData.id);

        // Extract content - use selftext if available, otherwise title
        const content = postData.selftext || postData.title;

        // Build the news item
        const newsItem: NewsItem = {
          id: `reddit_${postData.id}`,
          source: `Reddit r/${postData.subreddit}`,
          title: this.cleanTitle(postData.title),
          content: this.cleanContent(content),
          summary: this.generateSummary(postData),
          url: postData.url.startsWith('/r/') ? `${this.baseUrl}${postData.url}` : postData.url,
          publishedAt: new Date(postData.created_utc * 1000),
          author: postData.author,
          tags: this.extractTags(postData),
          metadata: {
            redditUrl: `${this.baseUrl}${postData.permalink}`,
            score: postData.score,
            comments: postData.num_comments,
            subreddit: postData.subreddit,
            flair: postData.link_flair_text,
            importance: this.calculateImportance(postData),
          },
        };

        newsItems.push(newsItem);
      }

      return newsItems;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 429) {
        console.warn(`Rate limited on r/${subreddit}, will retry next cycle`);
      } else {
        console.error(`Failed to fetch from r/${subreddit}:`, error);
      }
      return [];
    }
  }

  async searchNews(query: string, from?: Date, to?: Date): Promise<NewsItem[]> {
    const searchUrl = `${this.baseUrl}/search.json`;
    const allResults: NewsItem[] = [];

    try {
      const response = await axios.get<RedditResponse>(searchUrl, {
        headers: {
          'User-Agent': this.userAgent,
        },
        params: {
          q: query,
          sort: 'new',
          limit: 50,
          type: 'link',
          raw_json: 1,
        },
      });

      const posts = response.data.data.children;

      for (const post of posts) {
        const postData = post.data;
        const publishedAt = new Date(postData.created_utc * 1000);

        // Apply date filters if provided
        if (from && publishedAt < from) {
          continue;
        }
        if (to && publishedAt > to) {
          continue;
        }

        const newsItem: NewsItem = {
          id: `reddit_${postData.id}`,
          source: `Reddit r/${postData.subreddit}`,
          title: this.cleanTitle(postData.title),
          content: this.cleanContent(postData.selftext || postData.title),
          summary: this.generateSummary(postData),
          url: postData.url.startsWith('/r/') ? `${this.baseUrl}${postData.url}` : postData.url,
          publishedAt,
          author: postData.author,
          tags: this.extractTags(postData),
          metadata: {
            redditUrl: `${this.baseUrl}${postData.permalink}`,
            score: postData.score,
            comments: postData.num_comments,
            subreddit: postData.subreddit,
            flair: postData.link_flair_text,
          },
        };

        allResults.push(newsItem);
      }

      return allResults;
    } catch (error) {
      console.error('Reddit search failed:', error);
      return [];
    }
  }

  private cleanTitle(title: string): string {
    // Remove common Reddit title artifacts
    return title
      .replace(/\[.*?\]/g, '') // Remove bracketed tags
      .replace(/BREAKING:?/gi, '')
      .replace(/UPDATE:?/gi, '')
      .trim();
  }

  private cleanContent(content: string): string {
    // Clean up Reddit text formatting
    return content
      .replace(/&#x200B;/g, '') // Remove zero-width spaces
      .replace(/\n{3,}/g, '\n\n') // Collapse multiple newlines
      .trim();
  }

  private generateSummary(post: RedditPost['data']): string {
    const parts = [];

    if (post.link_flair_text) {
      parts.push(`[${post.link_flair_text}]`);
    }

    parts.push(post.title);

    if (post.selftext && post.selftext.length > 100) {
      parts.push(post.selftext.substring(0, 100) + '...');
    }

    return parts.join(' ');
  }

  private extractTags(post: RedditPost['data']): string[] {
    const tags: string[] = [];

    // Add subreddit as tag
    tags.push(post.subreddit);

    // Add flair as tag if present
    if (post.link_flair_text) {
      tags.push(post.link_flair_text.toLowerCase());
    }

    // Extract potential tags from title
    const title = post.title.toLowerCase();

    // Common news keywords to tag
    const keywords = [
      'breaking',
      'urgent',
      'federal reserve',
      'fed',
      'inflation',
      'gdp',
      'earnings',
      'merger',
      'acquisition',
      'ipo',
      'bankruptcy',
      'election',
      'sanctions',
      'trade',
      'covid',
      'war',
      'peace deal',
    ];

    for (const keyword of keywords) {
      if (title.includes(keyword)) {
        tags.push(keyword);
      }
    }

    return [...new Set(tags)]; // Remove duplicates
  }

  private calculateImportance(post: RedditPost['data']): 'low' | 'medium' | 'high' {
    // Calculate importance based on engagement metrics
    const score = post.score;
    const comments = post.num_comments;
    const age = Date.now() - post.created_utc * 1000;
    const ageHours = age / (1000 * 60 * 60);

    // Velocity metric: engagement per hour
    const velocity = (score + comments * 2) / Math.max(ageHours, 0.5);

    if (velocity > 500 || score > 1000) {
      return 'high';
    } else if (velocity > 100 || score > 200) {
      return 'medium';
    }

    return 'low';
  }

  async isHealthy(): Promise<boolean> {
    try {
      const response = await axios.get(`${this.baseUrl}/r/news/new.json?limit=1`, {
        headers: { 'User-Agent': this.userAgent },
        timeout: 5000,
      });
      return response.status === 200;
    } catch {
      return false;
    }
  }

  async destroy(): Promise<void> {
    this.lastFetchedIds.clear();
    console.log('Reddit News Service destroyed');
  }
}

export const RedditNewsServicePlugin: NewsServicePlugin = {
  create: (_config: NewsServiceConfig) => {
    const service = new RedditNewsService();
    return service;
  },
};
