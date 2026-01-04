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
  private baseUrl: string = 'https://api.elections.kalshi.com/trade-api/v2'; // Production API
  private demoUrl: string = 'https://demo-api.kalshi.co/trade-api/v2';
  private client!: AxiosInstance;
  private isDemoMode = true; // Default to demo since production endpoints are not accessible
  private excludedCategories: Set<string> = new Set();

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

    console.log(
      `Kalshi Platform initialized with API key authentication (${this.isDemoMode ? 'DEMO' : 'LIVE'} mode)`,
    );
    console.log(`Kalshi: excluding categories: ${Array.from(this.excludedCategories).join(', ')}`);
  }

  private generateJWT(method: string, path: string): string {
    const now = Math.floor(Date.now() / 1000);

    const payload = {
      iss: this.apiKeyId,
      sub: this.apiKeyId,
      iat: now,
      exp: now + 60, // Token expires in 60 seconds
      method: method,
      path: path,
    };

    return jwt.sign(payload, this.privateKey, { algorithm: 'RS256' });
  }

  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async getAvailableContracts(): Promise<Contract[]> {
    // First, fetch all events to get correct titles
    // The /markets endpoint returns incomplete titles (missing person names, etc.)
    // The /events endpoint has the complete titles
    const eventTitles = await this.fetchAllEventTitles();
    console.log(`Kalshi: fetched ${eventTitles.size} event titles`);

    const contracts: Contract[] = [];
    let cursor: string | undefined;

    do {
      // Rate limit: 20 req/s for basic tier, wait 100ms between requests
      await this.delay(100);

      // Retry logic with exponential backoff for rate limits
      let response;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          response = await this.client.get('/markets', {
            params: {
              status: 'open',
              limit: 200,
              cursor,
            },
          });
          break; // Success, exit retry loop
        } catch (error) {
          if (axios.isAxiosError(error) && error.response?.status === 429) {
            const waitTime = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s, 8s, 16s
            console.log(`Rate limited, waiting ${waitTime / 1000}s...`);
            await this.delay(waitTime);
          } else {
            throw error;
          }
        }
      }

      if (!response) {
        throw new Error('Failed to fetch markets after retries');
      }

      const markets: KalshiMarket[] = response.data.markets || [];
      cursor = response.data.cursor;

      // Only log every 10th page to reduce noise
      if (contracts.length % 2000 === 0 || !cursor) {
        console.log(`Kalshi: fetched ${contracts.length} markets so far...`);
      }

      const now = new Date();
      for (const market of markets) {
        // Skip markets that haven't opened yet (showing "launching in" on Kalshi)
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

    console.log(
      `Kalshi: ${contracts.length} total contracts found (excluding: ${Array.from(this.excludedCategories).join(', ')})`,
    );

    return contracts;
  }

  /**
   * Fetch all event titles from the /events endpoint
   * This is needed because /markets returns incomplete titles (missing person names, etc.)
   */
  private async fetchAllEventTitles(): Promise<Map<string, string>> {
    const eventTitles = new Map<string, string>();
    let cursor: string | undefined;

    do {
      await this.delay(100);

      let response;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          response = await this.client.get('/events', {
            params: {
              status: 'open',
              limit: 200,
              cursor,
            },
          });
          break;
        } catch (error) {
          if (axios.isAxiosError(error) && error.response?.status === 429) {
            const waitTime = Math.pow(2, attempt) * 1000;
            console.log(`Rate limited on events, waiting ${waitTime / 1000}s...`);
            await this.delay(waitTime);
          } else {
            throw error;
          }
        }
      }

      if (!response) {
        throw new Error('Failed to fetch events after retries');
      }

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
      const response = await this.client.get(`/markets/${contractId}`);
      const market: KalshiMarket = response.data.market;

      // Get the parent event for additional context
      const eventResponse = await this.client.get('/events', {
        params: {
          event_ticker: market.event_ticker,
        },
      });

      const event: KalshiEvent = eventResponse.data.events[0];

      return this.convertMarketToContract(market, event);
    } catch (error) {
      console.error(`Failed to fetch Kalshi contract ${contractId}:`, error);
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

    // Use event_ticker for URL - Kalshi's /events/{event_ticker} format works
    const eventTicker = market.event_ticker || market.ticker;

    // Contract title should describe the specific outcome, not the market question
    // Use yes_sub_title if available (e.g., "Loyola Marymount"), otherwise fall back to market title
    const contractTitle = market.yes_sub_title || market.title;

    // Use event title for marketTitle (it has the complete text, including person names)
    // Fall back to market.title if event title not found
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
        marketTitle, // Event title (complete) for deriving market-level title
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

    // Contract title should describe the specific outcome, not the market question
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
    try {
      // Convert our Order to Kalshi format
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

      console.log(
        `Placing Kalshi order: ${order.quantity} ${order.side} contracts of ${order.contractId}`,
      );

      const response = await this.client.post('/portfolio/orders', kalshiOrder);
      const placedOrder: KalshiOrder = response.data.order;

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
      console.error('Failed to place Kalshi order:', error);
      throw error;
    }
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    try {
      await this.client.delete(`/portfolio/orders/${orderId}`);
      console.log(`Kalshi order ${orderId} cancelled`);
      return true;
    } catch (error) {
      console.error(`Failed to cancel Kalshi order ${orderId}:`, error);
      return false;
    }
  }

  async getPositions(): Promise<Position[]> {
    try {
      const response = await this.client.get('/portfolio/positions');
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
      console.error('Failed to fetch Kalshi positions:', error);
      return [];
    }
  }

  async getBalance(): Promise<number> {
    try {
      const response = await this.client.get('/portfolio/balance');
      return response.data.balance / 100; // Convert cents to dollars
    } catch (error) {
      console.error('Failed to fetch Kalshi balance:', error);
      return 0;
    }
  }

  async getMarketResolution(contractId: string): Promise<MarketResolution | null> {
    try {
      const response = await this.client.get(`/markets/${contractId}`);
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
      console.error(`Failed to fetch Kalshi market resolution for ${contractId}:`, error);
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
    console.log('Kalshi Platform destroyed');
  }
}

export const KalshiPlatformPlugin: BettingPlatformPlugin = {
  create: (_config: BettingPlatformConfig) => {
    return new KalshiPlatform();
  },
};
