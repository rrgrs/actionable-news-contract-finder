import axios from 'axios';
import { NewsService, NewsServiceConfig, NewsItem, NewsServicePlugin } from '../../../types';

// Unused interface - commenting out to fix lint
// interface FinnhubNewsItem {
//   category: string;
//   datetime: number;
//   headline: string;
//   id: number;
//   image: string;
//   related: string;
//   source: string;
//   summary: string;
//   url: string;
// }

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

  // Major symbols to track for company news
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

  async initialize(config: NewsServiceConfig): Promise<void> {
    const customConfig = config.customConfig as Record<string, string> | undefined;
    this.apiKey = config.apiKey || customConfig?.apiKey || process.env.FINNHUB_API_KEY || '';

    if (!this.apiKey) {
      console.warn('Finnhub API key not provided. Using free tier with limitations.');
      console.warn('Get a free API key at https://finnhub.io');
      // Use a demo key for limited functionality
      this.apiKey = 'demo';
    }

    // Configure categories to fetch
    if (customConfig?.categories) {
      this.categories = customConfig.categories.split(',').map((c: string) => c.trim());
    }

    // Configure symbols to track
    if (customConfig?.symbols) {
      this.symbols = customConfig.symbols.split(',').map((s: string) => s.trim().toUpperCase());
    } else {
      this.symbols = [...this.defaultSymbols];
    }

    if (customConfig?.maxItemsPerCategory) {
      this.maxItemsPerCategory = parseInt(customConfig.maxItemsPerCategory);
    }

    console.log('Finnhub News Service initialized');
    console.log(`Categories: ${this.categories.join(', ')}`);
    console.log(`Tracking ${this.symbols.length} company symbols`);
  }

  async fetchLatestNews(): Promise<NewsItem[]> {
    const allNews: NewsItem[] = [];

    // Fetch market news by category
    for (const category of this.categories) {
      try {
        const categoryNews = await this.fetchMarketNews(category);
        allNews.push(...categoryNews);
      } catch (error) {
        console.error(`Error fetching Finnhub ${category} news:`, error);
      }
    }

    // Fetch company-specific news for top symbols
    const companyNewsPromises = this.symbols.slice(0, 5).map((symbol) =>
      this.fetchCompanyNews(symbol).catch((err) => {
        console.error(`Error fetching news for ${symbol}:`, err);
        return [];
      }),
    );

    const companyNewsResults = await Promise.all(companyNewsPromises);
    companyNewsResults.forEach((news) => allNews.push(...news));

    // Sort by publication date
    allNews.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());

    // Clean up old IDs to prevent memory leak
    if (this.processedIds.size > 2000) {
      const idsArray = Array.from(this.processedIds);
      this.processedIds = new Set(idsArray.slice(-1000));
    }

    return allNews;
  }

  private async fetchMarketNews(category: string): Promise<NewsItem[]> {
    try {
      const response = await axios.get<FinnhubMarketNews[]>(`${this.baseUrl}/news`, {
        params: {
          category: category,
          token: this.apiKey,
        },
        timeout: 10000,
      });

      const newsItems: NewsItem[] = [];
      const articles = response.data.slice(0, this.maxItemsPerCategory);

      for (const article of articles) {
        const id = `finnhub_${category}_${article.id}`;

        // Skip if already processed
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
        console.warn(`Rate limited on Finnhub ${category} news`);
      }
      return [];
    }
  }

  private async fetchCompanyNews(symbol: string): Promise<NewsItem[]> {
    try {
      // Calculate date range (last 7 days)
      const to = new Date();
      const from = new Date();
      from.setDate(from.getDate() - 7);

      const response = await axios.get<CompanyNews[]>(`${this.baseUrl}/company-news`, {
        params: {
          symbol: symbol,
          from: from.toISOString().split('T')[0],
          to: to.toISOString().split('T')[0],
          token: this.apiKey,
        },
        timeout: 10000,
      });

      const newsItems: NewsItem[] = [];
      const articles = response.data.slice(0, 5); // Limit per company

      for (const article of articles) {
        const id = `finnhub_${symbol}_${article.id}`;

        // Skip if already processed
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
    // Finnhub doesn't have a direct search endpoint
    // We'll fetch news and filter locally
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

    // Parse related symbols
    if (article.related) {
      const symbols = article.related.split(',');
      tags.push(...symbols.map((s) => s.trim().toLowerCase()));
    }

    // Extract keywords from headline
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

    // Parse related symbols
    if (article.related) {
      const symbols = article.related.split(',');
      tags.push(...symbols.map((s) => s.trim().toLowerCase()));
    }

    // Industry/sector tags based on symbol
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

    // High importance keywords
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

    // Medium importance keywords
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
    console.log('Finnhub News Service destroyed');
  }
}

export const FinnhubNewsServicePlugin: NewsServicePlugin = {
  create: (_config: NewsServiceConfig) => {
    const service = new FinnhubNewsService();
    return service;
  },
};
