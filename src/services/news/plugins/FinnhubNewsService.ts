import axios from 'axios';
import { NewsService, NewsServiceConfig, NewsItem, NewsServicePlugin } from '../../../types';
import { RateLimiter, withRateLimit } from '../../../utils/rateLimiter';
import { createLogger, Logger } from '../../../utils/logger';

interface FinnhubMarketNews {
  category: string;
  datetime: number;
  headline: string;
  id: number;
  image: string;
  related: string;
  source: string;
  summary: string;
  url: string;
}

interface CompanyNews {
  category: string;
  datetime: number;
  headline: string;
  id: number;
  image: string;
  related: string;
  source: string;
  summary: string;
  url: string;
}

export class FinnhubNewsService implements NewsService {
  name = 'finnhub-news';
  private apiKey: string = '';
  private baseUrl = 'https://finnhub.io/api/v1';
  private processedIds = new Set<string>();
  private categories: string[] = ['general', 'forex', 'crypto', 'merger'];
  private symbols: string[] = [];
  private maxItemsPerCategory = 20;
  private rateLimiter!: RateLimiter;
  private logger: Logger;

  private readonly defaultSymbols = [
    'AAPL',
    'MSFT',
    'GOOGL',
    'AMZN',
    'META',
    'TSLA',
    'NVDA',
    'JPM',
    'BAC',
    'WMT',
    'JNJ',
    'PG',
    'V',
    'MA',
    'HD',
    'DIS',
    'NFLX',
    'PYPL',
    'INTC',
    'AMD',
  ];

  constructor() {
    this.logger = createLogger('Finnhub');
  }

  async initialize(config: NewsServiceConfig): Promise<void> {
    const customConfig = config.customConfig as Record<string, string> | undefined;
    this.apiKey = config.apiKey || customConfig?.apiKey || process.env.FINNHUB_API_KEY || '';

    if (!this.apiKey) {
      this.logger.warn('API key not provided, using demo key with limitations');
      this.apiKey = 'demo';
    }

    // Initialize rate limiter (Finnhub free tier: 60 requests/minute)
    this.rateLimiter = new RateLimiter(
      {
        minDelayMs: 1000,
        requestsPerMinute: 60,
        maxRetries: 3,
        baseBackoffMs: 2000,
      },
      'Finnhub',
    );

    if (customConfig?.categories) {
      this.categories = customConfig.categories.split(',').map((c: string) => c.trim());
    }

    if (customConfig?.symbols) {
      this.symbols = customConfig.symbols.split(',').map((s: string) => s.trim().toUpperCase());
    } else {
      this.symbols = [...this.defaultSymbols];
    }

    if (customConfig?.maxItemsPerCategory) {
      this.maxItemsPerCategory = parseInt(customConfig.maxItemsPerCategory);
    }

    this.logger.info('Service initialized', {
      categories: this.categories.join(', '),
      symbolCount: this.symbols.length,
    });
  }

  async fetchLatestNews(): Promise<NewsItem[]> {
    const allNews: NewsItem[] = [];

    for (const category of this.categories) {
      try {
        const categoryNews = await this.fetchMarketNews(category);
        allNews.push(...categoryNews);
      } catch (error) {
        this.logger.error('Failed to fetch category news', {
          category,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const companyNewsPromises = this.symbols.slice(0, 5).map((symbol) =>
      this.fetchCompanyNews(symbol).catch((err) => {
        this.logger.error('Failed to fetch company news', {
          symbol,
          error: err instanceof Error ? err.message : String(err),
        });
        return [];
      }),
    );

    const companyNewsResults = await Promise.all(companyNewsPromises);
    companyNewsResults.forEach((news) => allNews.push(...news));

    allNews.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());

    if (this.processedIds.size > 2000) {
      const idsArray = Array.from(this.processedIds);
      this.processedIds = new Set(idsArray.slice(-1000));
    }

    return allNews;
  }

  private async fetchMarketNews(category: string): Promise<NewsItem[]> {
    try {
      const response = await withRateLimit(this.rateLimiter, () =>
        axios.get<FinnhubMarketNews[]>(`${this.baseUrl}/news`, {
          params: {
            category: category,
            token: this.apiKey,
          },
          timeout: 10000,
        }),
      );

      const newsItems: NewsItem[] = [];
      const articles = response.data.slice(0, this.maxItemsPerCategory);

      for (const article of articles) {
        const id = `finnhub_${category}_${article.id}`;

        if (this.processedIds.has(id)) {
          continue;
        }

        this.processedIds.add(id);

        const newsItem: NewsItem = {
          id: id,
          source: `Finnhub - ${article.source}`,
          title: article.headline,
          content: article.summary || article.headline,
          summary: article.summary || article.headline,
          url: article.url,
          publishedAt: new Date(article.datetime * 1000),
          author: article.source,
          tags: this.extractTags(article, category),
          metadata: {
            category: category,
            finnhubId: article.id,
            image: article.image,
            related: article.related,
            importance: this.calculateImportance(article),
          },
        };

        newsItems.push(newsItem);
      }

      return newsItems;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 429) {
        this.logger.warn('Rate limited', { category });
      }
      return [];
    }
  }

  private async fetchCompanyNews(symbol: string): Promise<NewsItem[]> {
    try {
      const to = new Date();
      const from = new Date();
      from.setDate(from.getDate() - 7);

      const response = await withRateLimit(this.rateLimiter, () =>
        axios.get<CompanyNews[]>(`${this.baseUrl}/company-news`, {
          params: {
            symbol: symbol,
            from: from.toISOString().split('T')[0],
            to: to.toISOString().split('T')[0],
            token: this.apiKey,
          },
          timeout: 10000,
        }),
      );

      const newsItems: NewsItem[] = [];
      const articles = response.data.slice(0, 5);

      for (const article of articles) {
        const id = `finnhub_${symbol}_${article.id}`;

        if (this.processedIds.has(id)) {
          continue;
        }

        this.processedIds.add(id);

        const newsItem: NewsItem = {
          id: id,
          source: `Finnhub - ${article.source}`,
          title: `${symbol}: ${article.headline}`,
          content: article.summary || article.headline,
          summary: article.summary || article.headline,
          url: article.url,
          publishedAt: new Date(article.datetime * 1000),
          author: article.source,
          tags: this.extractCompanyTags(article, symbol),
          metadata: {
            symbol: symbol,
            category: article.category,
            finnhubId: article.id,
            image: article.image,
            related: article.related,
            importance: this.calculateImportance(article),
          },
        };

        newsItems.push(newsItem);
      }

      return newsItems;
    } catch {
      return [];
    }
  }

  async searchNews(query: string, from?: Date, to?: Date): Promise<NewsItem[]> {
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

  private extractTags(article: FinnhubMarketNews, category: string): string[] {
    const tags: string[] = ['finnhub', category];

    if (article.related) {
      const symbols = article.related.split(',');
      tags.push(...symbols.map((s) => s.trim().toLowerCase()));
    }

    const headline = article.headline.toLowerCase();
    const keywords = [
      'earnings',
      'beat',
      'miss',
      'merger',
      'acquisition',
      'buyout',
      'ipo',
      'offering',
      'dividend',
      'buyback',
      'upgrade',
      'downgrade',
      'fda',
      'approval',
      'lawsuit',
      'settlement',
      'bankruptcy',
      'restructuring',
    ];

    for (const keyword of keywords) {
      if (headline.includes(keyword)) {
        tags.push(keyword);
      }
    }

    return [...new Set(tags)];
  }

  private extractCompanyTags(article: CompanyNews, symbol: string): string[] {
    const tags: string[] = ['finnhub', 'company', symbol.toLowerCase()];

    if (article.category) {
      tags.push(article.category);
    }

    if (article.related) {
      const symbols = article.related.split(',');
      tags.push(...symbols.map((s) => s.trim().toLowerCase()));
    }

    const techSymbols = ['AAPL', 'MSFT', 'GOOGL', 'META', 'NVDA', 'AMD', 'INTC'];
    const financeSymbols = ['JPM', 'BAC', 'GS', 'MS', 'C', 'WFC'];

    if (techSymbols.includes(symbol)) {
      tags.push('tech', 'technology');
    } else if (financeSymbols.includes(symbol)) {
      tags.push('finance', 'banking');
    }

    return [...new Set(tags)];
  }

  private calculateImportance(article: FinnhubMarketNews | CompanyNews): 'low' | 'medium' | 'high' {
    const headline = article.headline.toLowerCase();

    const highImportance = [
      'breaking',
      'urgent',
      'alert',
      'crash',
      'surge',
      'plunge',
      'federal reserve',
      'fed',
      'earnings beat',
      'earnings miss',
      'merger',
      'acquisition',
      'bankruptcy',
      'default',
    ];

    for (const keyword of highImportance) {
      if (headline.includes(keyword)) {
        return 'high';
      }
    }

    const mediumImportance = [
      'announce',
      'report',
      'update',
      'upgrade',
      'downgrade',
      'dividend',
      'buyback',
      'guidance',
      'forecast',
    ];

    for (const keyword of mediumImportance) {
      if (headline.includes(keyword)) {
        return 'medium';
      }
    }

    return 'low';
  }

  async isHealthy(): Promise<boolean> {
    try {
      const response = await axios.get(`${this.baseUrl}/news`, {
        params: {
          category: 'general',
          token: this.apiKey,
        },
        timeout: 5000,
      });
      return response.status === 200 && Array.isArray(response.data);
    } catch {
      return false;
    }
  }

  async destroy(): Promise<void> {
    this.processedIds.clear();
    this.logger.info('Service destroyed');
  }
}

export const FinnhubNewsServicePlugin: NewsServicePlugin = {
  create: (_config: NewsServiceConfig) => {
    const service = new FinnhubNewsService();
    return service;
  },
};
