import axios, { AxiosInstance } from 'axios';
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

interface KalshiAuth {
  token: string;
  member_id: string;
}

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
  private apiKey: string = '';
  private apiSecret: string = '';
  private baseUrl: string = 'https://trading-api.kalshi.com/trade-api/v2';
  private demoUrl: string = 'https://demo-api.kalshi.co/trade-api/v2';
  private client!: AxiosInstance;
  private auth: KalshiAuth | null = null;
  private isDemoMode = false;
  private authExpiry: Date | null = null;

  async initialize(config: BettingPlatformConfig): Promise<void> {
    const customConfig = config.customConfig as Record<string, unknown> | undefined;

    // Get API credentials
    this.apiKey =
      config.apiKey || (customConfig?.apiKey as string) || process.env.KALSHI_API_KEY || '';
    this.apiSecret =
      config.apiSecret ||
      (customConfig?.apiSecret as string) ||
      process.env.KALSHI_API_SECRET ||
      '';

    // Check for demo mode
    this.isDemoMode = customConfig?.demoMode === true || process.env.KALSHI_DEMO_MODE === 'true';

    if (!this.apiKey || !this.apiSecret) {
      throw new Error(
        'Kalshi API credentials not provided. Set KALSHI_API_KEY and KALSHI_API_SECRET in .env. ' +
          'Register at https://kalshi.com and get API credentials from your account settings.',
      );
    }

    // Initialize HTTP client
    this.client = axios.create({
      baseURL: this.isDemoMode ? this.demoUrl : this.baseUrl,
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    });

    // Authenticate
    await this.authenticate();

    console.log(`Kalshi Platform initialized (${this.isDemoMode ? 'DEMO' : 'LIVE'} mode)`);
  }

  private async authenticate(): Promise<void> {
    try {
      const response = await this.client.post('/login', {
        email: this.apiKey,
        password: this.apiSecret,
      });

      this.auth = {
        token: response.data.token,
        member_id: response.data.member_id,
      };

      // Set auth header for future requests
      this.client.defaults.headers.common['Authorization'] = `Bearer ${this.auth.token}`;

      // Token expires in 24 hours, refresh after 23 hours
      this.authExpiry = new Date(Date.now() + 23 * 60 * 60 * 1000);

      console.log('Kalshi authentication successful');
    } catch (error) {
      console.error('Kalshi authentication failed:', error);
      throw new Error('Failed to authenticate with Kalshi API');
    }
  }

  private async ensureAuthenticated(): Promise<void> {
    if (!this.auth || !this.authExpiry || new Date() > this.authExpiry) {
      await this.authenticate();
    }
  }

  async getAvailableContracts(): Promise<Contract[]> {
    try {
      await this.ensureAuthenticated();

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
      throw error;
    }
  }

  async getContract(contractId: string): Promise<Contract | null> {
    try {
      await this.ensureAuthenticated();

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
      await this.ensureAuthenticated();

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
      await this.ensureAuthenticated();

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
      await this.ensureAuthenticated();

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
      await this.ensureAuthenticated();

      const response = await this.client.get('/portfolio/balance');
      return response.data.balance / 100; // Convert cents to dollars
    } catch (error) {
      console.error('Failed to fetch Kalshi balance:', error);
      return 0;
    }
  }

  async getMarketResolution(contractId: string): Promise<MarketResolution | null> {
    try {
      await this.ensureAuthenticated();

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
      await this.ensureAuthenticated();
      const response = await this.client.get('/exchange/status');
      return response.data.trading_active === true;
    } catch {
      return false;
    }
  }

  async destroy(): Promise<void> {
    if (this.auth) {
      try {
        await this.client.post('/logout');
      } catch (error) {
        console.error('Error during Kalshi logout:', error);
      }
    }
    console.log('Kalshi Platform destroyed');
  }
}

export const KalshiPlatformPlugin: BettingPlatformPlugin = {
  create: (_config: BettingPlatformConfig) => {
    return new KalshiPlatform();
  },
};
