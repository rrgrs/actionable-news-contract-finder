import axios, { AxiosInstance } from 'axios';
import * as fs from 'fs';
import * as jwt from 'jsonwebtoken';
import {
  BettingPlatform,
  BettingPlatformConfig,
  BettingPlatformPlugin,
  MarketWithContracts,
  Contract,
} from '../../../types';
import { RateLimiter, withRateLimit } from '../../../utils/rateLimiter';
import { createLogger, Logger } from '../../../utils/logger';

/**
 * Kalshi API types
 * Mapping:
 * - Kalshi "Event" = Our "Market" (parent grouping)
 * - Kalshi "Market" = Our "Contract" (individual betting option with pricing)
 */

// From /markets endpoint - this becomes our Contract
interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  title: string;
  subtitle: string;
  yes_sub_title: string;
  no_sub_title: string;
  open_time: string;
  close_time: string;
  expiration_time: string;
  status: string;
  yes_ask: number;
  no_ask: number;
  volume: number;
  volume_24h: number;
  liquidity: number;
  category: string;
}

// From /events endpoint - this becomes our Market
interface KalshiEvent {
  event_ticker: string;
  series_ticker: string;
  sub_title: string;
  title: string;
  mutually_exclusive: boolean;
  category: string;
}

export class KalshiPlatform implements BettingPlatform {
  name = 'kalshi';
  private apiKeyId: string = '';
  private privateKey: string = '';
  private baseUrl: string = 'https://api.elections.kalshi.com/trade-api/v2';
  private demoUrl: string = 'https://demo-api.kalshi.co/trade-api/v2';
  private client!: AxiosInstance;
  private isDemoMode = true;
  private rateLimiter!: RateLimiter;
  private logger: Logger;

  constructor() {
    this.logger = createLogger('Kalshi');
  }

  async initialize(config: BettingPlatformConfig): Promise<void> {
    const customConfig = config.customConfig as Record<string, unknown> | undefined;

    this.apiKeyId = (customConfig?.apiKeyId as string) || process.env.KALSHI_API_KEY_ID || '';

    const privateKeyPath =
      (customConfig?.privateKeyPath as string) || process.env.KALSHI_PRIVATE_KEY_PATH || '';

    if (!this.apiKeyId || !privateKeyPath) {
      throw new Error(
        'Kalshi API credentials not provided. Set KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY_PATH in .env.',
      );
    }

    try {
      this.privateKey = fs.readFileSync(privateKeyPath, 'utf-8');
    } catch (error) {
      throw new Error(`Failed to read Kalshi private key from ${privateKeyPath}: ${error}`);
    }

    this.isDemoMode = customConfig?.demoMode === true || process.env.KALSHI_DEMO_MODE === 'true';

    this.rateLimiter = new RateLimiter(
      {
        minDelayMs: 200,
        requestsPerMinute: 300,
        maxRetries: 5,
        baseBackoffMs: 2000,
      },
      'Kalshi',
    );

    this.client = axios.create({
      baseURL: this.isDemoMode ? this.demoUrl : this.baseUrl,
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    });

    this.client.interceptors.request.use((config) => {
      const token = this.generateJWT(config.method?.toUpperCase() || 'GET', config.url || '');
      config.headers['Authorization'] = `Bearer ${token}`;
      return config;
    });

    this.logger.info('Platform initialized', {
      mode: this.isDemoMode ? 'DEMO' : 'LIVE',
    });
  }

  private generateJWT(method: string, path: string): string {
    const now = Math.floor(Date.now() / 1000);

    const payload = {
      iss: this.apiKeyId,
      sub: this.apiKeyId,
      iat: now,
      exp: now + 60,
      method: method,
      path: path,
    };

    return jwt.sign(payload, this.privateKey, { algorithm: 'RS256' });
  }

  async getMarkets(): Promise<MarketWithContracts[]> {
    // Fetch events (our Markets) and markets (our Contracts) separately
    const [eventsMap, marketsByEvent] = await Promise.all([
      this.fetchAllEvents(),
      this.fetchAllMarkets(),
    ]);

    // Build our Markets with their Contracts
    const results: MarketWithContracts[] = [];

    for (const [eventTicker, kalshiMarkets] of marketsByEvent) {
      const event = eventsMap.get(eventTicker);
      if (!event) {
        // No event found for these markets, skip
        continue;
      }

      const contracts = kalshiMarkets.map((m) => this.convertToContract(m));
      if (contracts.length === 0) {
        continue;
      }

      const endDate = kalshiMarkets.reduce((latest, m) => {
        const expDate = new Date(m.expiration_time);
        return expDate > latest ? expDate : latest;
      }, new Date(0));

      results.push({
        id: event.event_ticker,
        platform: 'kalshi',
        seriesTicker: event.series_ticker || undefined,
        title: event.title,
        subtitle: event.sub_title || undefined,
        url: `https://kalshi.com/events/${event.event_ticker}`,
        category: event.category || undefined,
        endDate: endDate.getTime() > 0 ? endDate : undefined,
        contracts,
      });
    }

    this.logger.info('Fetched all markets', {
      events: eventsMap.size,
      markets: results.reduce((sum, m) => sum + m.contracts.length, 0),
      total: results.length,
    });

    return results;
  }

  private async fetchAllEvents(): Promise<Map<string, KalshiEvent>> {
    const eventsMap = new Map<string, KalshiEvent>();
    let cursor: string | undefined;

    do {
      const response = await withRateLimit(this.rateLimiter, () =>
        this.client.get('/events', {
          params: {
            status: 'open',
            limit: 200,
            cursor,
          },
        }),
      );

      const events: KalshiEvent[] = response.data.events || [];
      cursor = response.data.cursor;

      for (const event of events) {
        eventsMap.set(event.event_ticker, event);
      }
    } while (cursor);

    this.logger.debug('Fetched events', { count: eventsMap.size });
    return eventsMap;
  }

  private async fetchAllMarkets(): Promise<Map<string, KalshiMarket[]>> {
    const marketsByEvent = new Map<string, KalshiMarket[]>();
    let cursor: string | undefined;
    const now = new Date();

    do {
      const response = await withRateLimit(this.rateLimiter, () =>
        this.client.get('/markets', {
          params: {
            status: 'open',
            limit: 200,
            cursor,
          },
        }),
      );

      const markets: KalshiMarket[] = response.data.markets || [];
      cursor = response.data.cursor;

      for (const market of markets) {
        // Filter: only active markets that have already started
        const openTime = new Date(market.open_time);
        if (openTime > now || market.status !== 'active') {
          continue;
        }

        const existing = marketsByEvent.get(market.event_ticker) || [];
        existing.push(market);
        marketsByEvent.set(market.event_ticker, existing);
      }
    } while (cursor);

    this.logger.debug('Fetched markets', { eventGroups: marketsByEvent.size });
    return marketsByEvent;
  }

  private convertToContract(market: KalshiMarket): Contract {
    const yesPrice = market.yes_ask ? market.yes_ask / 100 : 0.5;
    const noPrice = market.no_ask ? market.no_ask / 100 : 0.5;
    const title = market.yes_sub_title || market.title;

    return {
      id: market.ticker,
      title,
      yesPrice,
      noPrice,
      volume: market.volume,
      liquidity: market.liquidity,
      endDate: new Date(market.expiration_time),
    };
  }

  async isHealthy(): Promise<boolean> {
    try {
      const response = await this.client.get('/exchange/status');
      return response.data.trading_active === true;
    } catch {
      return false;
    }
  }

  async destroy(): Promise<void> {
    this.logger.info('Platform destroyed');
  }
}

export const KalshiPlatformPlugin: BettingPlatformPlugin = {
  create: (_config: BettingPlatformConfig) => {
    return new KalshiPlatform();
  },
};
