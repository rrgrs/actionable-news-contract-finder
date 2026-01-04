import axios from 'axios';
import { NewsService, NewsServiceConfig, NewsItem, NewsServicePlugin } from '../../../types';
import { RateLimiter, withRateLimit } from '../../../utils/rateLimiter';
import { createLogger, Logger } from '../../../utils/logger';

interface GDELTArticle {
  url: string;
  url_mobile?: string;
  title: string;
  seendate: string;
  socialimage?: string;
  domain: string;
  language: string;
  sourcecountry?: string;
  theme?: string;
  tone?: number;
  goldsteinscale?: number;
}

interface GDELTResponse {
  articles?: GDELTArticle[];
  status?: string;
  message?: string;
}

export class GDELTNewsService implements NewsService {
  name = 'gdelt-news';
  private baseUrl = 'https://api.gdeltproject.org/api/v2';
  private processedUrls = new Set<string>();
  private maxRecords = 250;
  private languages = ['english'];
  private keywords: string[] = [];
  private countries: string[] = [];
  private minTone: number | null = null;
  private maxTone: number | null = null;
  private rateLimiter!: RateLimiter;
  private logger: Logger;

  private readonly defaultKeywords = [
    'federal reserve',
    'interest rate',
    'stock market',
    'earnings',
    'merger',
    'acquisition',
    'IPO',
    'bankruptcy',
    'inflation',
  ];

  constructor() {
    this.logger = createLogger('GDELT');
  }

  async initialize(config: NewsServiceConfig): Promise<void> {
    const customConfig = config.customConfig as Record<string, string | number> | undefined;

    if (customConfig?.maxRecords) {
      this.maxRecords = parseInt(String(customConfig.maxRecords));
    }

    if (customConfig?.languages) {
      this.languages = String(customConfig.languages)
        .split(',')
        .map((l: string) => l.trim());
    }

    if (customConfig?.keywords) {
      this.keywords = String(customConfig.keywords)
        .split(',')
        .map((k: string) => k.trim());
    } else {
      this.keywords = [...this.defaultKeywords];
    }

    if (customConfig?.countries) {
      this.countries = String(customConfig.countries)
        .split(',')
        .map((c: string) => c.trim());
    }

    if (customConfig?.minTone !== undefined) {
      this.minTone = parseFloat(String(customConfig.minTone));
    }

    if (customConfig?.maxTone !== undefined) {
      this.maxTone = parseFloat(String(customConfig.maxTone));
    }

    // Initialize rate limiter (GDELT is generous but we'll be conservative)
    this.rateLimiter = new RateLimiter(
      {
        minDelayMs: 1000,
        requestsPerMinute: 30,
        maxRetries: 3,
        baseBackoffMs: 2000,
      },
      'GDELT',
    );

    this.logger.info('Service initialized', {
      languages: this.languages.join(', '),
      keywordCount: this.keywords.length,
      countries: this.countries.length > 0 ? this.countries.join(', ') : 'all',
    });
  }

  async fetchLatestNews(): Promise<NewsItem[]> {
    const allNews: NewsItem[] = [];

    try {
      const articles = await this.searchArticles();
      allNews.push(...articles);

      if (this.shouldFetchTV()) {
        const tvNews = await this.fetchTVNews();
        allNews.push(...tvNews);
      }
    } catch (error) {
      this.logger.error('Failed to fetch news', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    allNews.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());

    if (this.processedUrls.size > 2000) {
      const urlsArray = Array.from(this.processedUrls);
      this.processedUrls = new Set(urlsArray.slice(-1000));
    }

    return allNews;
  }

  private async searchArticles(query?: string): Promise<NewsItem[]> {
    const params: Record<string, string | number> = {
      query: query || this.buildQuery(),
      mode: 'artlist',
      format: 'json',
      maxrecords: this.maxRecords,
      sort: 'datedesc',
    };

    if (this.languages.length > 0) {
      params.sourcelang = this.languages.join(' OR ');
    }

    if (this.countries.length > 0) {
      params.sourcecountry = this.countries.join(' OR ');
    }

    if (this.minTone !== null) {
      params.mintone = this.minTone;
    }
    if (this.maxTone !== null) {
      params.maxtone = this.maxTone;
    }

    try {
      const response = await withRateLimit(this.rateLimiter, () =>
        axios.get<GDELTResponse>(`${this.baseUrl}/doc/doc`, {
          params,
          timeout: 30000,
        }),
      );

      if (typeof response.data === 'string') {
        this.logger.error('API returned error', { message: response.data });
        return [];
      }

      if (response.data.status === 'error') {
        this.logger.error('API error', { message: response.data.message });
        return [];
      }

      const articles = response.data.articles || [];
      const newsItems: NewsItem[] = [];

      for (const article of articles) {
        if (this.processedUrls.has(article.url)) {
          continue;
        }

        this.processedUrls.add(article.url);

        // Validate date before creating NewsItem
        const publishedAt = new Date(article.seendate);
        const validPublishedAt =
          publishedAt instanceof Date && !isNaN(publishedAt.getTime()) ? publishedAt : new Date();

        const newsItem: NewsItem = {
          id: `gdelt_${this.generateId(article.url)}`,
          source: `GDELT - ${article.domain}`,
          title: article.title,
          content: await this.fetchArticleContent(article),
          summary: article.title,
          url: article.url,
          publishedAt: validPublishedAt,
          author: article.domain,
          tags: this.extractTags(article),
          metadata: {
            domain: article.domain,
            country: article.sourcecountry,
            language: article.language,
            tone: article.tone,
            goldsteinScale: article.goldsteinscale,
            theme: article.theme,
            socialImage: article.socialimage,
            importance: this.calculateImportance(article),
          },
        };

        newsItems.push(newsItem);
      }

      return newsItems;
    } catch (error) {
      this.logger.error('Article search failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  private buildQuery(): string {
    if (this.keywords.length === 0) {
      return '("stock market" OR "federal reserve")';
    }

    const quotedKeywords = this.keywords.map((kw) => (kw.includes(' ') ? `"${kw}"` : kw));

    return `(${quotedKeywords.join(' OR ')})`;
  }

  private async fetchArticleContent(article: GDELTArticle): Promise<string> {
    const content = [
      article.title,
      '',
      `Source: ${article.domain}`,
      article.sourcecountry ? `Country: ${article.sourcecountry}` : '',
      article.theme ? `Theme: ${article.theme}` : '',
      article.tone ? `Tone: ${article.tone.toFixed(2)} (${this.describeTone(article.tone)})` : '',
    ]
      .filter((line) => line)
      .join('\n');

    return content;
  }

  private describeTone(tone: number): string {
    if (tone > 5) {
      return 'Very Positive';
    }
    if (tone > 1) {
      return 'Positive';
    }
    if (tone < -5) {
      return 'Very Negative';
    }
    if (tone < -1) {
      return 'Negative';
    }
    return 'Neutral';
  }

  private async fetchTVNews(): Promise<NewsItem[]> {
    return [];
  }

  private shouldFetchTV(): boolean {
    return false;
  }

  async searchNews(query: string, from?: Date, to?: Date): Promise<NewsItem[]> {
    let searchQuery = query;

    if (from || to) {
      const fromStr = from ? from.toISOString().split('T')[0].replace(/-/g, '') : '*';
      const toStr = to ? to.toISOString().split('T')[0].replace(/-/g, '') : '*';
      searchQuery += ` timespan:${fromStr}-${toStr}`;
    }

    return this.searchArticles(searchQuery);
  }

  private extractTags(article: GDELTArticle): string[] {
    const tags: string[] = ['gdelt'];

    if (article.language) {
      tags.push(article.language.toLowerCase());
    }

    if (article.sourcecountry) {
      tags.push(article.sourcecountry.toLowerCase());
    }

    if (article.theme) {
      const themes = article.theme.split(';');
      for (const theme of themes) {
        const cleanTheme = theme.trim().toLowerCase().replace(/_/g, ' ');
        if (cleanTheme) {
          tags.push(cleanTheme);
        }
      }
    }

    if (article.tone) {
      if (article.tone > 5) {
        tags.push('positive');
      } else if (article.tone < -5) {
        tags.push('negative');
      }
    }

    const title = article.title.toLowerCase();
    const keywords = [
      'breaking',
      'urgent',
      'federal reserve',
      'fed',
      'inflation',
      'interest rate',
      'earnings',
      'ipo',
      'merger',
      'bankruptcy',
      'bitcoin',
      'crypto',
    ];

    for (const keyword of keywords) {
      if (title.includes(keyword)) {
        tags.push(keyword);
      }
    }

    return [...new Set(tags)];
  }

  private calculateImportance(article: GDELTArticle): 'low' | 'medium' | 'high' {
    const title = article.title.toLowerCase();

    if (
      title.includes('breaking') ||
      title.includes('urgent') ||
      title.includes('federal reserve') ||
      title.includes('crash') ||
      title.includes('surge')
    ) {
      return 'high';
    }

    if (article.tone && (article.tone > 10 || article.tone < -10)) {
      return 'high';
    }

    if (article.goldsteinscale && Math.abs(article.goldsteinscale) > 8) {
      return 'high';
    }

    if (
      title.includes('announce') ||
      title.includes('report') ||
      (article.tone && Math.abs(article.tone) > 5)
    ) {
      return 'medium';
    }

    return 'low';
  }

  private generateId(text: string): string {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
  }

  async isHealthy(): Promise<boolean> {
    try {
      const response = await axios.get(`${this.baseUrl}/doc/doc`, {
        params: {
          query: 'test',
          mode: 'artlist',
          format: 'json',
          maxrecords: 1,
        },
        timeout: 5000,
      });
      return response.status === 200 && response.data.status !== 'error';
    } catch {
      return false;
    }
  }

  async destroy(): Promise<void> {
    this.processedUrls.clear();
    this.logger.info('Service destroyed');
  }
}

export const GDELTNewsServicePlugin: NewsServicePlugin = {
  create: (_config: NewsServiceConfig) => {
    const service = new GDELTNewsService();
    return service;
  },
};
