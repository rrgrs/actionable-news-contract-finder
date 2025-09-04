import { NewsItem, NewsService, NewsServiceConfig, NewsServicePlugin } from '../../../types';

export class MockNewsService implements NewsService {
  name: string;
  private isInitialized = false;

  constructor(config: NewsServiceConfig) {
    this.name = config.name;
  }

  async initialize(config: NewsServiceConfig): Promise<void> {
    this.isInitialized = true;
    console.log(`MockNewsService initialized with config:`, config.name);
  }

  async fetchLatestNews(): Promise<NewsItem[]> {
    if (!this.isInitialized) {
      throw new Error('Service not initialized');
    }

    const mockNews: NewsItem[] = [
      {
        id: `mock-${Date.now()}-1`,
        source: 'Mock News Service',
        title: 'Federal Reserve Announces Unexpected Rate Cut',
        content:
          'The Federal Reserve announced an unexpected 0.5% rate cut today, citing concerns about global economic slowdown. Markets rallied on the news with S&P 500 up 2%.',
        summary: 'Fed cuts rates by 0.5%, markets rally',
        url: 'https://mock.news/fed-rate-cut',
        publishedAt: new Date(),
        author: 'Mock Reporter',
        tags: ['economy', 'federal-reserve', 'interest-rates'],
        metadata: { importance: 'high' },
      },
      {
        id: `mock-${Date.now()}-2`,
        source: 'Mock News Service',
        title: 'Tesla Announces New Battery Technology Breakthrough',
        content:
          'Tesla revealed a new battery technology that could increase range by 50% and reduce costs by 30%. Production expected to begin in Q2 2025.',
        summary: 'Tesla unveils game-changing battery tech',
        url: 'https://mock.news/tesla-battery',
        publishedAt: new Date(Date.now() - 3600000),
        author: 'Mock Tech Writer',
        tags: ['technology', 'tesla', 'electric-vehicles'],
        metadata: { importance: 'medium' },
      },
    ];

    return mockNews;
  }

  async searchNews(query: string, from?: Date, to?: Date): Promise<NewsItem[]> {
    if (!this.isInitialized) {
      throw new Error('Service not initialized');
    }

    console.log(`Searching for news: ${query} from ${from} to ${to}`);
    const news = await this.fetchLatestNews();
    return news.filter(
      (item) =>
        item.title.toLowerCase().includes(query.toLowerCase()) ||
        item.content.toLowerCase().includes(query.toLowerCase()),
    );
  }

  async isHealthy(): Promise<boolean> {
    return this.isInitialized;
  }

  async destroy(): Promise<void> {
    this.isInitialized = false;
    console.log('MockNewsService destroyed');
  }
}

export const MockNewsServicePlugin: NewsServicePlugin = {
  create(config: NewsServiceConfig): NewsService {
    return new MockNewsService(config);
  },
};
