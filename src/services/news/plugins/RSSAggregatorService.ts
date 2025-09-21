import axios from 'axios';
import { NewsService, NewsServiceConfig, NewsItem, NewsServicePlugin } from '../../../types';

interface RSSFeed {
  name: string;
  url: string;
  category?: string;
}

// Commented out unused interface
// interface RSSItem {
//   title: string;
//   link: string;
//   description?: string;
//   pubDate?: string;
//   guid?: string;
//   creator?: string;
//   category?: string[];
//   content?: string;
// }

export class RSSAggregatorService implements NewsService {
  name = 'rss-aggregator';
  private feeds: RSSFeed[] = [];
  private processedGuids = new Set<string>();
  private maxItemsPerFeed = 20;
  // private dedupTimeWindowMs = 3600000; // 1 hour - unused
  private lastFetchTime: Map<string, Date> = new Map();

  // Default high-quality news feeds
  private readonly defaultFeeds: RSSFeed[] = [
    {
      name: 'Reuters Top News',
      url: 'https://feeds.reuters.com/reuters/topNews',
      category: 'general',
    },
    {
      name: 'Reuters Business',
      url: 'https://feeds.reuters.com/reuters/businessNews',
      category: 'business',
    },
    {
      name: 'Reuters Markets',
      url: 'https://feeds.reuters.com/reuters/marketNews',
      category: 'markets',
    },
    {
      name: 'Bloomberg Markets',
      url: 'https://feeds.bloomberg.com/markets/news.rss',
      category: 'markets',
    },
    { name: 'AP Top News', url: 'https://feeds.apnews.com/rss/apf-topnews', category: 'general' },
    { name: 'BBC World', url: 'http://feeds.bbci.co.uk/news/world/rss.xml', category: 'world' },
    {
      name: 'CNN Top Stories',
      url: 'http://rss.cnn.com/rss/cnn_topstories.rss',
      category: 'general',
    },
    { name: 'Financial Times', url: 'https://www.ft.com/?format=rss', category: 'finance' },
    {
      name: 'WSJ Markets',
      url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml',
      category: 'markets',
    },
    {
      name: 'CNBC Top News',
      url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html',
      category: 'business',
    },
  ];

  async initialize(config: NewsServiceConfig): Promise<void> {
    const customConfig = config.customConfig as Record<string, string> | undefined;

    // Load custom feeds from config or use defaults
    if (customConfig?.feeds) {
      const feedUrls = customConfig.feeds.split(',').map((f: string) => f.trim());
      this.feeds = feedUrls.map((url: string) => ({
        name: this.extractFeedName(url),
        url,
      }));
    } else {
      this.feeds = [...this.defaultFeeds];
    }

    if (customConfig?.maxItemsPerFeed) {
      this.maxItemsPerFeed = parseInt(customConfig.maxItemsPerFeed);
    }

    console.log(`RSS Aggregator initialized with ${this.feeds.length} feeds`);
    this.feeds.forEach((feed) => {
      console.log(`  - ${feed.name}: ${feed.url}`);
    });
  }

  async fetchLatestNews(): Promise<NewsItem[]> {
    const allNews: NewsItem[] = [];
    const fetchPromises = this.feeds.map((feed) => this.fetchFeed(feed));

    // Fetch all feeds in parallel for speed
    const results = await Promise.allSettled(fetchPromises);

    results.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value) {
        allNews.push(...result.value);
      } else if (result.status === 'rejected') {
        console.error(`Failed to fetch ${this.feeds[index].name}:`, result.reason);
      }
    });

    // Deduplicate news items by title similarity
    const deduplicatedNews = this.deduplicateNews(allNews);

    // Sort by publication date (newest first)
    deduplicatedNews.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());

    // Clean up old GUIDs to prevent memory leak
    if (this.processedGuids.size > 2000) {
      const guidsArray = Array.from(this.processedGuids);
      this.processedGuids = new Set(guidsArray.slice(-1000));
    }

    return deduplicatedNews;
  }

  private async fetchFeed(feed: RSSFeed): Promise<NewsItem[]> {
    try {
      // Use a simple RSS to JSON service for parsing
      const response = await axios.get(`https://api.rss2json.com/v1/api.json`, {
        params: {
          rss_url: feed.url,
          count: this.maxItemsPerFeed,
        },
        timeout: 10000,
      });

      if (response.data.status !== 'ok') {
        throw new Error(`RSS feed error: ${response.data.message}`);
      }

      const items: NewsItem[] = [];
      const feedItems = response.data.items || [];

      for (const item of feedItems) {
        const guid = item.guid || item.link;

        // Skip if already processed
        if (this.processedGuids.has(guid)) {
          continue;
        }

        this.processedGuids.add(guid);

        const newsItem: NewsItem = {
          id: `rss_${this.generateId(guid)}`,
          source: feed.name,
          title: this.cleanText(item.title),
          content: this.extractContent(item),
          summary: this.cleanText(item.description || item.title),
          url: item.link,
          publishedAt: item.pubDate ? new Date(item.pubDate) : new Date(),
          author: item.author || item.creator || feed.name,
          tags: this.extractTags(item, feed),
          metadata: {
            feedUrl: feed.url,
            category: feed.category,
            guid: guid,
            importance: this.calculateImportance(item),
          },
        };

        items.push(newsItem);
      }

      // Update last fetch time
      this.lastFetchTime.set(feed.url, new Date());

      return items;
    } catch {
      // Fallback to direct XML parsing if RSS2JSON fails
      return this.fetchFeedDirectly(feed);
    }
  }

  private async fetchFeedDirectly(feed: RSSFeed): Promise<NewsItem[]> {
    try {
      const response = await axios.get(feed.url, {
        headers: {
          Accept: 'application/rss+xml, application/xml, text/xml',
        },
        timeout: 10000,
      });

      const items: NewsItem[] = [];
      const xml = response.data;

      // Simple XML parsing using regex (not perfect but works for most RSS)
      const itemMatches = xml.match(/<item>([\s\S]*?)<\/item>/gi) || [];

      for (const itemXml of itemMatches.slice(0, this.maxItemsPerFeed)) {
        const title = this.extractXmlTag(itemXml, 'title');
        const link = this.extractXmlTag(itemXml, 'link');
        const description = this.extractXmlTag(itemXml, 'description');
        const pubDate = this.extractXmlTag(itemXml, 'pubDate');
        const guid = this.extractXmlTag(itemXml, 'guid') || link;

        if (!title || !link) {
          continue;
        }

        // Skip if already processed
        if (this.processedGuids.has(guid)) {
          continue;
        }

        this.processedGuids.add(guid);

        const newsItem: NewsItem = {
          id: `rss_${this.generateId(guid)}`,
          source: feed.name,
          title: this.cleanText(title),
          content: this.cleanText(description || title),
          summary: this.cleanText(description || title).substring(0, 200),
          url: link,
          publishedAt: pubDate ? new Date(pubDate) : new Date(),
          author: feed.name,
          tags: this.extractTagsFromText(title + ' ' + description, feed),
          metadata: {
            feedUrl: feed.url,
            category: feed.category,
            guid: guid,
            importance: 'medium',
          },
        };

        items.push(newsItem);
      }

      return items;
    } catch (error) {
      console.error(`Failed to fetch RSS feed ${feed.name} directly:`, error);
      return [];
    }
  }

  private extractXmlTag(xml: string, tag: string): string {
    const match = xml.match(
      new RegExp(`<${tag}><!\\[CDATA\\[(.*?)\\]\\]></${tag}>|<${tag}>(.*?)</${tag}>`, 's'),
    );
    return match ? (match[1] || match[2] || '').trim() : '';
  }

  async searchNews(query: string, from?: Date, to?: Date): Promise<NewsItem[]> {
    // For RSS feeds, we'll fetch latest and filter
    const allNews = await this.fetchLatestNews();

    return allNews.filter((item) => {
      const matchesQuery =
        item.title.toLowerCase().includes(query.toLowerCase()) ||
        item.content.toLowerCase().includes(query.toLowerCase());

      const matchesDateRange =
        (!from || item.publishedAt >= from) && (!to || item.publishedAt <= to);

      return matchesQuery && matchesDateRange;
    });
  }

  private extractContent(item: Record<string, unknown>): string {
    // Try to get the most complete content
    const content =
      (item.content as string) ||
      (item['content:encoded'] as string) ||
      (item.description as string) ||
      (item.title as string) ||
      '';
    return this.cleanText(content);
  }

  private cleanText(text: string): string {
    if (!text) {
      return '';
    }

    return text
      .replace(/<[^>]*>/g, '') // Remove HTML tags
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  private extractTags(item: Record<string, unknown>, feed: RSSFeed): string[] {
    const tags: string[] = [];

    // Add feed category
    if (feed.category) {
      tags.push(feed.category);
    }

    // Add item categories
    const categories = item.categories;
    if (categories) {
      if (Array.isArray(categories)) {
        tags.push(...(categories as string[]));
      } else if (typeof categories === 'string') {
        tags.push(categories);
      }
    }

    // Extract keywords from title and description
    const text = `${item.title || ''} ${item.description || ''}`.toLowerCase();
    const keywords = [
      'breaking',
      'urgent',
      'exclusive',
      'federal reserve',
      'fed',
      'interest rate',
      'inflation',
      'gdp',
      'unemployment',
      'earnings',
      'merger',
      'acquisition',
      'ipo',
      'election',
      'policy',
      'regulation',
      'bitcoin',
      'crypto',
      'stock market',
    ];

    for (const keyword of keywords) {
      if (text.includes(keyword)) {
        tags.push(keyword);
      }
    }

    return [...new Set(tags)];
  }

  private extractTagsFromText(text: string, feed: RSSFeed): string[] {
    const tags: string[] = [];

    if (feed.category) {
      tags.push(feed.category);
    }

    const lowerText = text.toLowerCase();
    const keywords = [
      'breaking',
      'urgent',
      'federal reserve',
      'inflation',
      'earnings',
      'merger',
      'ipo',
      'bitcoin',
      'election',
    ];

    for (const keyword of keywords) {
      if (lowerText.includes(keyword)) {
        tags.push(keyword);
      }
    }

    return [...new Set(tags)];
  }

  private extractFeedName(url: string): string {
    try {
      const domain = new URL(url).hostname.replace('www.', '').replace('feeds.', '');
      return domain.split('.')[0].toUpperCase();
    } catch {
      return 'RSS Feed';
    }
  }

  private generateId(text: string): string {
    // Simple hash function for generating IDs
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
  }

  private calculateImportance(item: Record<string, unknown>): 'low' | 'medium' | 'high' {
    const title = ((item.title as string) || '').toLowerCase();
    const description = ((item.description as string) || '').toLowerCase();
    const text = title + ' ' + description;

    // High importance keywords
    if (
      text.includes('breaking') ||
      text.includes('urgent') ||
      text.includes('federal reserve') ||
      text.includes('interest rate') ||
      text.includes('crash') ||
      text.includes('surge')
    ) {
      return 'high';
    }

    // Medium importance keywords
    if (
      text.includes('announce') ||
      text.includes('report') ||
      text.includes('earnings') ||
      text.includes('merger')
    ) {
      return 'medium';
    }

    return 'low';
  }

  private deduplicateNews(items: NewsItem[]): NewsItem[] {
    const uniqueItems: NewsItem[] = [];
    const seenTitles = new Set<string>();

    for (const item of items) {
      // Create a normalized title for comparison
      const normalizedTitle = item.title
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

      // Check for very similar titles (could be enhanced with fuzzy matching)
      let isDuplicate = false;
      for (const seenTitle of seenTitles) {
        if (this.areSimilar(normalizedTitle, seenTitle)) {
          isDuplicate = true;
          break;
        }
      }

      if (!isDuplicate) {
        uniqueItems.push(item);
        seenTitles.add(normalizedTitle);
      }
    }

    return uniqueItems;
  }

  private areSimilar(str1: string, str2: string): boolean {
    // Simple similarity check - could be enhanced with Levenshtein distance
    const words1 = str1.split(' ');
    const words2 = str2.split(' ');

    if (Math.abs(words1.length - words2.length) > 3) {
      return false;
    }

    let commonWords = 0;
    for (const word of words1) {
      if (words2.includes(word) && word.length > 3) {
        commonWords++;
      }
    }

    const similarity = commonWords / Math.max(words1.length, words2.length);
    return similarity > 0.7;
  }

  async isHealthy(): Promise<boolean> {
    try {
      // Check if at least one feed is accessible
      const healthChecks = this.feeds.slice(0, 3).map((feed) =>
        axios
          .head(feed.url, { timeout: 5000 })
          .then(() => true)
          .catch(() => false),
      );

      const results = await Promise.all(healthChecks);
      return results.some((result) => result === true);
    } catch {
      return false;
    }
  }

  async destroy(): Promise<void> {
    this.processedGuids.clear();
    this.lastFetchTime.clear();
    console.log('RSS Aggregator Service destroyed');
  }
}

export const RSSAggregatorServicePlugin: NewsServicePlugin = {
  create: (_config: NewsServiceConfig) => {
    const service = new RSSAggregatorService();
    return service;
  },
};
