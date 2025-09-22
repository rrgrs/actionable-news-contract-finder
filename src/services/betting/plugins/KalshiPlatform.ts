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

export class KalshiPlatform implements BettingPlatform {
  name = 'kalshi';
  private apiKeyId: string = '';
  private privateKey: string = '';
  private baseUrl: string = 'https://demo-api.kalshi.co/trade-api/v2'; // Demo is currently the only working endpoint
  private demoUrl: string = 'https://demo-api.kalshi.co/trade-api/v2';
  private client!: AxiosInstance;
  private isDemoMode = true; // Default to demo since production endpoints are not accessible

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

  async getAvailableContracts(): Promise<Contract[]> {
    try {
      // Fetch all active events
      const response = await this.client.get('/events', {
        params: {
          status: 'open',
          limit: 100,
        },
      });

      const events: KalshiEvent[] = response.data.events;
      const contracts: Contract[] = [];

      // Convert Kalshi markets to our Contract format
      for (const event of events) {
        for (const market of event.markets) {
          if (market.status !== 'open') {
            continue;
          }

          contracts.push(this.convertMarketToContract(market, event));
        }
      }

      return contracts;
    } catch (error) {
      console.error('Failed to fetch Kalshi contracts:', error);
      if (axios.isAxiosError(error) && error.response) {
        console.error('Error response:', error.response.data);
      }
      throw error;
    }
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

  private convertMarketToContract(market: KalshiMarket, event: KalshiEvent): Contract {
    const now = new Date();
    const closeTime = new Date(market.close_time);
    const expirationTime = new Date(market.expiration_time);

    // Calculate best prices (in cents to dollars)
    const yesPrice = market.yes_ask ? market.yes_ask / 100 : 0.5;
    const noPrice = market.no_ask ? market.no_ask / 100 : 0.5;

    return {
      id: market.ticker,
      platform: 'kalshi',
      title: market.title,
      description: `${event.title}: ${market.subtitle}`,
      yesPrice,
      noPrice,
      volume: market.volume,
      liquidity: market.liquidity,
      endDate: expirationTime,
      tags: [event.category, market.market_type],
      url: `https://kalshi.com/markets/${market.ticker}`,
      metadata: {
        eventTicker: event.event_ticker,
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
