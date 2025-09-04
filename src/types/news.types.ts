export interface NewsItem {
  id: string;
  source: string;
  title: string;
  content: string;
  summary?: string;
  url: string;
  publishedAt: Date;
  author?: string;
  tags?: string[];
  metadata?: Record<string, any>;
}

export interface NewsServiceConfig {
  name: string;
  apiKey?: string;
  baseUrl?: string;
  pollInterval?: number;
  maxItemsPerPoll?: number;
  customConfig?: Record<string, any>;
}

export interface NewsService {
  name: string;
  initialize(config: NewsServiceConfig): Promise<void>;
  fetchLatestNews(): Promise<NewsItem[]>;
  searchNews(query: string, from?: Date, to?: Date): Promise<NewsItem[]>;
  isHealthy(): Promise<boolean>;
  destroy(): Promise<void>;
}

export interface NewsServicePlugin {
  create(config: NewsServiceConfig): NewsService;
}
