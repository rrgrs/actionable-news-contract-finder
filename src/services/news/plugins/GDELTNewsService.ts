import axios from 'axios';
import { NewsService, NewsServiceConfig, NewsItem, NewsServicePlugin } from '../../../types';

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
  // private updateInterval = 15; // GDELT updates every 15 minutes - unused
  private maxRecords = 250;
  private languages = ['english'];
  private themes: string[] = [];
  private countries: string[] = [];
  private minTone: number | null = null;
  private maxTone: number | null = null;

  // GDELT themes relevant to financial markets
  private readonly marketThemes = [
    'ECON_STOCKMARKET',
    'ECON_INTEREST_RATE',
    'ECON_INFLATION',
    'ECON_CURRENCY',
    'ECON_TRADE',
    'ECON_BANKRUPTCY',
    'ECON_MERGER',
    'ECON_IPO',
    'TAX_POLICY',
    'CENTRAL_BANK',
    'FEDERAL_RESERVE',
    'WB_ECONOMICS',
    'WB_FINANCE',
    'CRYPTOCURRENCY',
    'COMMODITY_MARKETS',
  ];

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

    if (customConfig?.themes) {
      this.themes = String(customConfig.themes)
        .split(',')
        .map((t: string) => t.trim());
    } else {
      // Use default market-related themes
      this.themes = [...this.marketThemes];
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

    console.log('GDELT News Service initialized');
    console.log(`Languages: ${this.languages.join(', ')}`);
    console.log(`Monitoring ${this.themes.length} themes`);
    if (this.countries.length > 0) {
      console.log(`Countries: ${this.countries.join(', ')}`);
    }
  }

  async fetchLatestNews(): Promise<NewsItem[]> {
    const allNews: NewsItem[] = [];

    try {
      // GDELT Doc API for article search
      const articles = await this.searchArticles();
      allNews.push(...articles);

      // Also fetch from GDELT TV if configured
      if (this.shouldFetchTV()) {
        const tvNews = await this.fetchTVNews();
        allNews.push(...tvNews);
      }
    } catch (error) {
      console.error('Error fetching GDELT news:', error);
    }

    // Sort by publication date
    allNews.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());

    // Clean up old URLs to prevent memory leak
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

    // Add language filter
    if (this.languages.length > 0) {
      params.sourcelang = this.languages.join(' OR ');
    }

    // Add country filter
    if (this.countries.length > 0) {
      params.sourcecountry = this.countries.join(' OR ');
    }

    // Add tone filters
    if (this.minTone !== null) {
      params.mintone = this.minTone;
    }
    if (this.maxTone !== null) {
      params.maxtone = this.maxTone;
    }

    try {
      const response = await axios.get<GDELTResponse>(`${this.baseUrl}/doc/doc`, {
        params,
        timeout: 30000, // Increased timeout to 30 seconds for GDELT API
      });

      if (response.data.status === 'error') {
        console.error('GDELT API error:', response.data.message);
        return [];
      }

      const articles = response.data.articles || [];
      const newsItems: NewsItem[] = [];

      for (const article of articles) {
        // Skip if already processed
        if (this.processedUrls.has(article.url)) {
          continue;
        }

        this.processedUrls.add(article.url);

        const newsItem: NewsItem = {
          id: `gdelt_${this.generateId(article.url)}`,
          source: `GDELT - ${article.domain}`,
          title: article.title,
          content: await this.fetchArticleContent(article),
          summary: article.title,
          url: article.url,
          publishedAt: new Date(article.seendate),
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
      console.error('GDELT article search failed:', error);
      return [];
    }
  }

  private buildQuery(): string {
    const queries: string[] = [];

    // Add theme queries
    if (this.themes.length > 0) {
      queries.push(`theme:${this.themes.join(' OR theme:')}`);
    }

    // Add default financial keywords if no themes specified
    if (queries.length === 0) {
      queries.push(
        '("federal reserve" OR "interest rate" OR "stock market" OR ' +
          '"earnings report" OR "merger" OR "acquisition" OR "IPO" OR ' +
          '"bankruptcy" OR "inflation" OR "GDP" OR "unemployment")',
      );
    }

    return queries.join(' AND ');
  }

  private async fetchArticleContent(article: GDELTArticle): Promise<string> {
    // GDELT doesn't provide article content directly
    // We use the title and metadata to create a summary
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
    // GDELT TV API for broadcast news
    // This requires additional configuration and is optional
    return [];
  }

  private shouldFetchTV(): boolean {
    // TV news can be enabled via config
    return false;
  }

  async searchNews(query: string, from?: Date, to?: Date): Promise<NewsItem[]> {
    let searchQuery = query;

    // Add date filters to query
    if (from || to) {
      const fromStr = from ? from.toISOString().split('T')[0].replace(/-/g, '') : '*';
      const toStr = to ? to.toISOString().split('T')[0].replace(/-/g, '') : '*';
      searchQuery += ` timespan:${fromStr}-${toStr}`;
    }

    return this.searchArticles(searchQuery);
  }

  private extractTags(article: GDELTArticle): string[] {
    const tags: string[] = ['gdelt'];

    // Add language
    if (article.language) {
      tags.push(article.language.toLowerCase());
    }

    // Add country
    if (article.sourcecountry) {
      tags.push(article.sourcecountry.toLowerCase());
    }

    // Parse theme for tags
    if (article.theme) {
      const themes = article.theme.split(';');
      for (const theme of themes) {
        const cleanTheme = theme.trim().toLowerCase().replace(/_/g, ' ');
        if (cleanTheme) {
          tags.push(cleanTheme);
        }
      }
    }

    // Add tone-based tags
    if (article.tone) {
      if (article.tone > 5) {
        tags.push('positive');
      } else if (article.tone < -5) {
        tags.push('negative');
      }
    }

    // Extract keywords from title
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

    // High importance based on keywords
    if (
      title.includes('breaking') ||
      title.includes('urgent') ||
      title.includes('federal reserve') ||
      title.includes('crash') ||
      title.includes('surge')
    ) {
      return 'high';
    }

    // High importance based on extreme tone
    if (article.tone && (article.tone > 10 || article.tone < -10)) {
      return 'high';
    }

    // High importance based on Goldstein scale (conflict/cooperation measure)
    if (article.goldsteinscale && Math.abs(article.goldsteinscale) > 8) {
      return 'high';
    }

    // Medium importance
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
    console.log('GDELT News Service destroyed');
  }
}

export const GDELTNewsServicePlugin: NewsServicePlugin = {
  create: (_config: NewsServiceConfig) => {
    const service = new GDELTNewsService();
    return service;
  },
};
