import axios, { AxiosInstance } from 'axios';
import { ethers } from 'ethers';
import {
  BettingPlatform,
  BettingPlatformConfig,
  BettingPlatformPlugin,
  MarketWithContracts,
  Contract,
} from '../../../types';
import { RateLimiter, withRateLimit } from '../../../utils/rateLimiter';
import { createLogger, Logger } from '../../../utils/logger';

interface PolymarketMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  resolutionSource: string;
  endDate: string;
  liquidity: string;
  volume: string;
  volume24hr: string;
  clobTokenIds: string[];
  outcomes: string[];
  outcomePrices: string[];
  minimum_order_size: number;
  minimum_tick_size: number;
  description: string;
  tags: string[];
  active: boolean;
  closed: boolean;
  archived: boolean;
  accepting_orders: boolean;
  resolved: boolean;
  resolvedOutcome?: string;
}

export class PolymarketPlatform implements BettingPlatform {
  name = 'polymarket';
  private apiKey: string = '';
  private apiSecret: string = '';
  private privateKey: string = '';
  private baseUrl: string = 'https://clob.polymarket.com';
  private dataUrl: string = 'https://gamma-api.polymarket.com';
  private client!: AxiosInstance;
  private dataClient!: AxiosInstance;
  private wallet: ethers.Wallet | null = null;
  private address: string = '';
  private rateLimiter!: RateLimiter;
  private logger: Logger;

  constructor() {
    this.logger = createLogger('Polymarket');
  }

  async initialize(config: BettingPlatformConfig): Promise<void> {
    const customConfig = config.customConfig as Record<string, unknown> | undefined;

    // Get API credentials and private key
    this.apiKey =
      config.apiKey || (customConfig?.apiKey as string) || process.env.POLYMARKET_API_KEY || '';
    this.apiSecret =
      config.apiSecret ||
      (customConfig?.apiSecret as string) ||
      process.env.POLYMARKET_API_SECRET ||
      '';
    this.privateKey =
      (customConfig?.privateKey as string) || process.env.POLYMARKET_PRIVATE_KEY || '';

    if (!this.apiKey || !this.apiSecret) {
      this.logger.warn('API credentials not provided, running in read-only mode');
    }

    if (!this.privateKey && this.apiKey && this.apiSecret) {
      throw new Error(
        'Polymarket private key required for trading. Set POLYMARKET_PRIVATE_KEY in .env.',
      );
    }

    // Initialize wallet if we have a private key
    if (this.privateKey) {
      this.wallet = new ethers.Wallet(this.privateKey);
      this.address = this.wallet.address;
      this.logger.info('Wallet configured', { address: this.address });
    }

    // Initialize rate limiter (conservative defaults for Polymarket)
    this.rateLimiter = new RateLimiter(
      {
        minDelayMs: 200,
        requestsPerMinute: 120,
        maxRetries: 3,
        baseBackoffMs: 1000,
      },
      'Polymarket',
    );

    // Initialize HTTP clients
    this.client = axios.create({
      baseURL: this.baseUrl,
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    });

    this.dataClient = axios.create({
      baseURL: this.dataUrl,
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    });

    // Set auth headers if we have credentials
    if (this.apiKey && this.apiSecret) {
      this.client.defaults.headers.common['Authorization'] = `Bearer ${this.apiKey}`;
      this.client.defaults.headers.common['X-Api-Secret'] = this.apiSecret;
    }

    this.logger.info('Platform initialized', {
      mode: this.apiKey ? 'authenticated' : 'read-only',
    });
  }

  async getMarkets(): Promise<MarketWithContracts[]> {
    try {
      const response = await withRateLimit(this.rateLimiter, () =>
        this.dataClient.get('/markets', {
          params: {
            active: true,
            closed: false,
            limit: 100,
            order: 'volume24hr',
            ascending: false,
          },
        }),
      );

      const polymarketMarkets: PolymarketMarket[] = response.data;
      const markets: MarketWithContracts[] = [];

      for (const market of polymarketMarkets) {
        if (market.resolved) {
          continue;
        }
        markets.push(this.convertPolymarketToMarket(market));
      }

      this.logger.info('Fetched markets', { count: markets.length });
      return markets;
    } catch (error) {
      this.logger.error('Failed to fetch markets', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private convertPolymarketToMarket(market: PolymarketMarket): MarketWithContracts {
    const prices = market.outcomePrices.map((p) => parseFloat(p));
    const yesPrice = prices[0] || 0.5;
    const noPrice = prices[1] || 0.5;

    // In Polymarket, each market is a single question with outcomes
    // We model this as a market with one contract (the main Yes/No bet)
    const contract: Contract = {
      id: market.id,
      title: market.outcomes[0] || 'Yes', // Primary outcome label
      yesPrice,
      noPrice,
      volume: parseFloat(market.volume),
      liquidity: parseFloat(market.liquidity),
      endDate: new Date(market.endDate),
    };

    return {
      id: market.id,
      platform: 'polymarket',
      title: market.question,
      url: `https://polymarket.com/event/${market.slug}`,
      category: market.tags[0] || undefined,
      endDate: new Date(market.endDate),
      contracts: [contract],
    };
  }

  async isHealthy(): Promise<boolean> {
    try {
      const response = await this.dataClient.get('/markets', {
        params: { limit: 1 },
      });
      return response.status === 200 && Array.isArray(response.data);
    } catch {
      return false;
    }
  }

  async destroy(): Promise<void> {
    this.logger.info('Platform destroyed');
  }
}

export const PolymarketPlatformPlugin: BettingPlatformPlugin = {
  create: (_config: BettingPlatformConfig) => {
    return new PolymarketPlatform();
  },
};
