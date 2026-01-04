import axios, { AxiosInstance } from 'axios';
import * as fs from 'fs';
import * as jwt from 'jsonwebtoken';
import {
  BettingPlatform,
  BettingPlatformConfig,
  BettingPlatformPlugin,
  Contract,
  Order,
  OrderStatus,
  Position,
  MarketResolution,
} from '../../../types';
import { RateLimiter, withRateLimit } from '../../../utils/rateLimiter';
import { createLogger, Logger } from '../../../utils/logger';

interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  market_type: string;
  title: string;
  subtitle: string;
  yes_sub_title: string;
  no_sub_title: string;
  open_time: string;
  close_time: string;
  expected_expiration_time: string;
  expiration_time: string;
  settlement_time: string;
  status: string;
  yes_ask: number;
  yes_bid: number;
  no_ask: number;
  no_bid: number;
  last_price: number;
  previous_yes_ask: number;
  previous_yes_bid: number;
  previous_price: number;
  volume: number;
  volume_24h: number;
  liquidity: number;
  open_interest: number;
  result: string;
  can_close_early: boolean;
  expiration_value: string;
  category: string;
  risk_limit_cents: number;
  strike_type: string;
  floor_strike: number;
  cap_strike: number;
  custom_strike: number;
}

interface KalshiEvent {
  event_ticker: string;
  series_ticker: string;
  sub_title: string;
  title: string;
  mutually_exclusive: boolean;
  category: string;
  markets: KalshiMarket[];
}

interface KalshiOrder {
  order_id: string;
  user_id: string;
  ticker: string;
  client_order_id: string;
  side: 'yes' | 'no';
  action: 'buy' | 'sell';
  count: number;
  yes_price: number;
  no_price: number;
  type: 'market' | 'limit';
  status: string;
  expiration_time: string;
  created_time: string;
  updated_time: string;
}

interface KalshiPosition {
  ticker: string;
  market_exposure: number;
  realized_pnl: number;
  total_traded: number;
  resting_order_count: number;
  position: number;
  fees_paid: number;
}

interface KalshiOrderRequest {
  ticker: string;
  client_order_id?: string;
  side: 'yes' | 'no';
  action: 'buy' | 'sell';
  count: number;
  type: 'market' | 'limit';
  yes_price?: number;
  no_price?: number;
  expiration_ts?: number;
}

// Default categories to exclude from Kalshi queries
const DEFAULT_EXCLUDED_CATEGORIES = ['Sports', 'Crypto', 'Climate', 'Mentions'];

export class KalshiPlatform implements BettingPlatform {
  name = 'kalshi';
  private apiKeyId: string = '';
  private privateKey: string = '';
  private baseUrl: string = 'https://api.elections.kalshi.com/trade-api/v2';
  private demoUrl: string = 'https://demo-api.kalshi.co/trade-api/v2';
  private client!: AxiosInstance;
  private isDemoMode = true;
  private excludedCategories: Set<string> = new Set();
  private rateLimiter!: RateLimiter;
  private logger: Logger;

  constructor() {
    this.logger = createLogger('Kalshi');
  }

  async initialize(config: BettingPlatformConfig): Promise<void> {
    const customConfig = config.customConfig as Record<string, unknown> | undefined;

    // Get API Key ID
    this.apiKeyId = (customConfig?.apiKeyId as string) || process.env.KALSHI_API_KEY_ID || '';

    // Get Private Key Path and read the key
    const privateKeyPath =
      (customConfig?.privateKeyPath as string) || process.env.KALSHI_PRIVATE_KEY_PATH || '';

    if (!this.apiKeyId || !privateKeyPath) {
      throw new Error(
        'Kalshi API credentials not provided. Set KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY_PATH in .env.',
      );
    }

    // Read private key from file
    try {
      this.privateKey = fs.readFileSync(privateKeyPath, 'utf-8');
    } catch (error) {
      throw new Error(`Failed to read Kalshi private key from ${privateKeyPath}: ${error}`);
    }

    // Check for demo mode
    this.isDemoMode = customConfig?.demoMode === true || process.env.KALSHI_DEMO_MODE === 'true';

    // Initialize excluded categories (case-insensitive matching)
    const excludedCategoriesEnv = process.env.KALSHI_EXCLUDED_CATEGORIES;
    const categoriesToExclude = excludedCategoriesEnv
      ? excludedCategoriesEnv.split(',').map((c) => c.trim().toLowerCase())
      : DEFAULT_EXCLUDED_CATEGORIES.map((c) => c.toLowerCase());
    this.excludedCategories = new Set(categoriesToExclude);

    // Initialize rate limiter (Kalshi allows ~10 req/sec for basic tier)
    this.rateLimiter = new RateLimiter(
      {
        minDelayMs: 100,
        requestsPerMinute: 600,
        maxRetries: 5,
        baseBackoffMs: 1000,
      },
      'Kalshi',
    );

    // Initialize HTTP client
    this.client = axios.create({
      baseURL: this.isDemoMode ? this.demoUrl : this.baseUrl,
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    });

    // Add request interceptor to sign requests
    this.client.interceptors.request.use((config) => {
      const token = this.generateJWT(config.method?.toUpperCase() || 'GET', config.url || '');
      config.headers['Authorization'] = `Bearer ${token}`;
      return config;
    });

    this.logger.info('Platform initialized', {
      mode: this.isDemoMode ? 'DEMO' : 'LIVE',
      excludedCategories: Array.from(this.excludedCategories).join(', '),
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

  async getAvailableContracts(): Promise<Contract[]> {
    // First, fetch all events to get correct titles
    const eventTitles = await this.fetchAllEventTitles();
    this.logger.debug('Fetched event titles', { count: eventTitles.size });

    const contracts: Contract[] = [];
    let cursor: string | undefined;

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

      // Log progress every 2000 markets
      if (contracts.length % 2000 === 0 || !cursor) {
        this.logger.debug('Fetching markets', { fetched: contracts.length });
      }

      const now = new Date();
      for (const market of markets) {
        // Skip markets that haven't opened yet
        const openTime = new Date(market.open_time);
        if (openTime > now) {
          continue;
        }

        // Skip markets in excluded categories
        if (market.category && this.excludedCategories.has(market.category.toLowerCase())) {
          continue;
        }

        contracts.push(this.convertMarketToContractSimple(market, eventTitles));
      }
    } while (cursor);

    this.logger.info('Fetched all contracts', {
      total: contracts.length,
      excludedCategories: Array.from(this.excludedCategories).join(', '),
    });

    return contracts;
  }

  /**
   * Fetch all event titles from the /events endpoint.
   * The /markets endpoint returns incomplete titles (missing person names, etc.)
   */
  private async fetchAllEventTitles(): Promise<Map<string, string>> {
    const eventTitles = new Map<string, string>();
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
        eventTitles.set(event.event_ticker, event.title);
      }
    } while (cursor);

    return eventTitles;
  }

  async getContract(contractId: string): Promise<Contract | null> {
    try {
      const response = await withRateLimit(this.rateLimiter, () =>
        this.client.get(`/markets/${contractId}`),
      );
      const market: KalshiMarket = response.data.market;

      // Get the parent event for additional context
      const eventResponse = await withRateLimit(this.rateLimiter, () =>
        this.client.get('/events', {
          params: {
            event_ticker: market.event_ticker,
          },
        }),
      );

      const event: KalshiEvent = eventResponse.data.events[0];

      return this.convertMarketToContract(market, event);
    } catch (error) {
      this.logger.error('Failed to fetch contract', {
        contractId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private convertMarketToContractSimple(
    market: KalshiMarket,
    eventTitles: Map<string, string>,
  ): Contract {
    const now = new Date();
    const closeTime = new Date(market.close_time);
    const expirationTime = new Date(market.expiration_time);

    // Calculate best prices (in cents to dollars)
    const yesPrice = market.yes_ask ? market.yes_ask / 100 : 0.5;
    const noPrice = market.no_ask ? market.no_ask / 100 : 0.5;

    // Use event_ticker for URL
    const eventTicker = market.event_ticker || market.ticker;

    // Contract title should describe the specific outcome
    const contractTitle = market.yes_sub_title || market.title;

    // Use event title for marketTitle (complete text including person names)
    const marketTitle = eventTitles.get(market.event_ticker) || market.title;

    return {
      id: market.ticker,
      platform: 'kalshi',
      title: contractTitle,
      yesPrice,
      noPrice,
      volume: market.volume,
      liquidity: market.liquidity,
      endDate: expirationTime,
      tags: [market.category, market.market_type].filter(Boolean),
      url: `https://kalshi.com/events/${eventTicker}`,
      metadata: {
        eventTicker: market.event_ticker,
        marketTicker: market.ticker,
        marketTitle,
        yesSubTitle: market.yes_sub_title,
        noSubTitle: market.no_sub_title,
        volume24h: market.volume_24h,
        openInterest: market.open_interest,
        lastPrice: market.last_price / 100,
        yesBid: market.yes_bid / 100,
        noBid: market.no_bid / 100,
        canCloseEarly: market.can_close_early,
        riskLimitCents: market.risk_limit_cents,
        isOpen: market.status === 'open' && closeTime > now,
      },
    };
  }

  private convertMarketToContract(market: KalshiMarket, event: KalshiEvent): Contract {
    const now = new Date();
    const closeTime = new Date(market.close_time);
    const expirationTime = new Date(market.expiration_time);

    // Calculate best prices (in cents to dollars)
    const yesPrice = market.yes_ask ? market.yes_ask / 100 : 0.5;
    const noPrice = market.no_ask ? market.no_ask / 100 : 0.5;

    // Contract title should describe the specific outcome
    const contractTitle = market.yes_sub_title || market.title;

    return {
      id: market.ticker,
      platform: 'kalshi',
      title: contractTitle,
      yesPrice,
      noPrice,
      volume: market.volume,
      liquidity: market.liquidity,
      endDate: expirationTime,
      tags: [event.category, market.market_type],
      url: `https://kalshi.com/events/${event.event_ticker}`,
      metadata: {
        eventTicker: event.event_ticker,
        marketTicker: market.ticker,
        seriesTicker: event.series_ticker,
        yesSubTitle: market.yes_sub_title,
        noSubTitle: market.no_sub_title,
        volume24h: market.volume_24h,
        openInterest: market.open_interest,
        lastPrice: market.last_price / 100,
        yesBid: market.yes_bid / 100,
        noBid: market.no_bid / 100,
        canCloseEarly: market.can_close_early,
        riskLimitCents: market.risk_limit_cents,
        isOpen: market.status === 'open' && closeTime > now,
      },
    };
  }

  async placeOrder(order: Order): Promise<OrderStatus> {
    const kalshiOrder: KalshiOrderRequest = {
      ticker: order.contractId,
      client_order_id: `ancf_${Date.now()}`,
      side: order.side as 'yes' | 'no',
      action: 'buy',
      count: order.quantity,
      type: order.orderType as 'market' | 'limit',
    };

    // Set price based on side (Kalshi uses cents)
    if (order.orderType === 'limit' && order.limitPrice) {
      if (order.side === 'yes') {
        kalshiOrder.yes_price = Math.round(order.limitPrice * 100);
      } else {
        kalshiOrder.no_price = Math.round(order.limitPrice * 100);
      }
    }

    this.logger.info('Placing order', {
      contractId: order.contractId,
      side: order.side,
      quantity: order.quantity,
      type: order.orderType,
    });

    try {
      const response = await withRateLimit(this.rateLimiter, () =>
        this.client.post('/portfolio/orders', kalshiOrder),
      );
      const placedOrder: KalshiOrder = response.data.order;

      this.logger.info('Order placed', {
        orderId: placedOrder.order_id,
        status: placedOrder.status,
      });

      return {
        orderId: placedOrder.order_id,
        status: this.mapOrderStatus(placedOrder.status),
        filledQuantity: placedOrder.status === 'executed' ? placedOrder.count : 0,
        averagePrice: placedOrder.yes_price
          ? placedOrder.yes_price / 100
          : placedOrder.no_price / 100,
        timestamp: new Date(placedOrder.created_time),
      };
    } catch (error) {
      this.logger.error('Failed to place order', {
        contractId: order.contractId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    try {
      await withRateLimit(this.rateLimiter, () =>
        this.client.delete(`/portfolio/orders/${orderId}`),
      );
      this.logger.info('Order cancelled', { orderId });
      return true;
    } catch (error) {
      this.logger.error('Failed to cancel order', {
        orderId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async getPositions(): Promise<Position[]> {
    try {
      const response = await withRateLimit(this.rateLimiter, () =>
        this.client.get('/portfolio/positions'),
      );
      const kalshiPositions: KalshiPosition[] = response.data.market_positions;

      const positions: Position[] = [];

      for (const pos of kalshiPositions) {
        if (pos.position === 0) {
          continue;
        }

        // Get market details for more info
        const contract = await this.getContract(pos.ticker);
        if (!contract) {
          continue;
        }

        positions.push({
          contractId: pos.ticker,
          platform: 'kalshi',
          quantity: Math.abs(pos.position),
          side: pos.position > 0 ? 'yes' : 'no',
          averagePrice: pos.total_traded / Math.abs(pos.position) / 100,
          currentPrice: contract.yesPrice,
          unrealizedPnl:
            ((contract.yesPrice * 100 - pos.total_traded / Math.abs(pos.position)) * pos.position) /
            100,
          realizedPnl: pos.realized_pnl / 100,
        });
      }

      return positions;
    } catch (error) {
      this.logger.error('Failed to fetch positions', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  async getBalance(): Promise<number> {
    try {
      const response = await withRateLimit(this.rateLimiter, () =>
        this.client.get('/portfolio/balance'),
      );
      return response.data.balance / 100;
    } catch (error) {
      this.logger.error('Failed to fetch balance', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  async getMarketResolution(contractId: string): Promise<MarketResolution | null> {
    try {
      const response = await withRateLimit(this.rateLimiter, () =>
        this.client.get(`/markets/${contractId}`),
      );
      const market: KalshiMarket = response.data.market;

      if (market.status !== 'settled') {
        return null;
      }

      return {
        contractId,
        resolved: true,
        outcome: market.result === 'yes' ? 'yes' : market.result === 'no' ? 'no' : 'invalid',
        settlementPrice: market.result === 'yes' ? 1 : 0,
        timestamp: new Date(market.settlement_time),
      };
    } catch (error) {
      this.logger.error('Failed to fetch market resolution', {
        contractId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private mapOrderStatus(kalshiStatus: string): 'pending' | 'filled' | 'cancelled' | 'failed' {
    switch (kalshiStatus) {
      case 'resting':
      case 'pending':
        return 'pending';
      case 'executed':
        return 'filled';
      case 'canceled':
        return 'cancelled';
      default:
        return 'failed';
    }
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
