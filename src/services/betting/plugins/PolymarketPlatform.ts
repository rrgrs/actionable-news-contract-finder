import axios, { AxiosInstance } from 'axios';
import { ethers } from 'ethers';
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

interface PolymarketOrder {
  id: string;
  market: string;
  asset_id: string;
  side: 'BUY' | 'SELL';
  size: string;
  price: string;
  status: string;
  created_at: string;
  updated_at: string;
  filled_size: string;
  unfilled_size: string;
  average_price?: string;
}

interface PolymarketPosition {
  market: string;
  asset_id: string;
  position: string;
  average_price: string;
  realized_pnl: string;
  unrealized_pnl: string;
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

  async getAvailableContracts(): Promise<Contract[]> {
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

      const markets: PolymarketMarket[] = response.data;
      const contracts: Contract[] = [];

      for (const market of markets) {
        if (market.resolved) {
          continue;
        }
        contracts.push(this.convertMarketToContract(market));
      }

      this.logger.info('Fetched contracts', { count: contracts.length });
      return contracts;
    } catch (error) {
      this.logger.error('Failed to fetch contracts', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async getContract(contractId: string): Promise<Contract | null> {
    try {
      const response = await withRateLimit(this.rateLimiter, () =>
        this.dataClient.get(`/markets/${contractId}`),
      );
      const market: PolymarketMarket = response.data;

      return this.convertMarketToContract(market);
    } catch (error) {
      this.logger.error('Failed to fetch contract', {
        contractId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private convertMarketToContract(market: PolymarketMarket): Contract {
    const prices = market.outcomePrices.map((p) => parseFloat(p));
    const yesPrice = prices[0] || 0.5;
    const noPrice = prices[1] || 0.5;

    return {
      id: market.id,
      platform: 'polymarket',
      title: market.question,
      yesPrice,
      noPrice,
      volume: parseFloat(market.volume),
      liquidity: parseFloat(market.liquidity),
      endDate: new Date(market.endDate),
      tags: market.tags,
      url: `https://polymarket.com/event/${market.slug}`,
      metadata: {
        conditionId: market.conditionId,
        slug: market.slug,
        resolutionSource: market.resolutionSource,
        volume24hr: parseFloat(market.volume24hr),
        clobTokenIds: market.clobTokenIds as string[],
        outcomes: market.outcomes as string[],
        minimumOrderSize: market.minimum_order_size,
        minimumTickSize: market.minimum_tick_size,
        active: market.active,
        acceptingOrders: market.accepting_orders,
        resolved: market.resolved,
        resolvedOutcome: market.resolvedOutcome,
      } as Record<string, unknown>,
    };
  }

  async placeOrder(order: Order): Promise<OrderStatus> {
    if (!this.apiKey || !this.apiSecret || !this.wallet) {
      throw new Error('Polymarket trading requires API credentials and private key');
    }

    const market = await this.getContract(order.contractId);
    if (!market) {
      throw new Error(`Market ${order.contractId} not found`);
    }

    const clobTokenIds = market.metadata?.clobTokenIds as string[] | undefined;
    const tokenId = clobTokenIds?.[order.side === 'yes' ? 0 : 1];
    if (!tokenId) {
      throw new Error(`Token ID not found for ${order.side} side of market ${order.contractId}`);
    }

    const orderPayload = {
      market: order.contractId,
      asset_id: tokenId,
      side: 'BUY',
      size: order.quantity.toString(),
      price: (order.limitPrice || market.yesPrice).toString(),
      type: order.orderType === 'market' ? 'MARKET' : 'LIMIT',
      client_order_id: `ancf_${Date.now()}`,
    };

    const signature = await this.signOrder(orderPayload);

    this.logger.info('Placing order', {
      contractId: order.contractId,
      side: order.side,
      quantity: order.quantity,
    });

    try {
      const response = await withRateLimit(this.rateLimiter, () =>
        this.client.post('/orders', {
          ...orderPayload,
          signature,
          address: this.address,
        }),
      );

      const placedOrder: PolymarketOrder = response.data;

      this.logger.info('Order placed', {
        orderId: placedOrder.id,
        status: placedOrder.status,
      });

      return {
        orderId: placedOrder.id,
        status: this.mapOrderStatus(placedOrder.status),
        filledQuantity: parseFloat(placedOrder.filled_size),
        averagePrice: placedOrder.average_price
          ? parseFloat(placedOrder.average_price)
          : order.limitPrice || 0,
        timestamp: new Date(placedOrder.created_at),
      };
    } catch (error) {
      this.logger.error('Failed to place order', {
        contractId: order.contractId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async signOrder(order: Record<string, unknown>): Promise<string> {
    if (!this.wallet) {
      throw new Error('No wallet configured for signing');
    }

    const message = JSON.stringify(order);
    return await this.wallet.signMessage(message);
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    if (!this.apiKey || !this.apiSecret) {
      throw new Error('Polymarket order cancellation requires API credentials');
    }

    try {
      await withRateLimit(this.rateLimiter, () => this.client.delete(`/orders/${orderId}`));
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
    if (!this.apiKey || !this.apiSecret) {
      this.logger.warn('Cannot fetch positions without API credentials');
      return [];
    }

    try {
      const response = await withRateLimit(this.rateLimiter, () =>
        this.client.get('/positions', {
          params: { address: this.address },
        }),
      );

      const polyPositions: PolymarketPosition[] = response.data;
      const positions: Position[] = [];

      for (const pos of polyPositions) {
        const positionSize = parseFloat(pos.position);
        if (positionSize === 0) {
          continue;
        }

        const market = await this.getContract(pos.market);
        if (!market) {
          continue;
        }

        const clobTokenIds = market.metadata?.clobTokenIds as string[] | undefined;
        const isYes = clobTokenIds?.[0] === pos.asset_id;
        const currentPrice = isYes ? market.yesPrice : market.noPrice;

        positions.push({
          contractId: pos.market,
          platform: 'polymarket',
          quantity: Math.abs(positionSize),
          side: isYes ? 'yes' : 'no',
          averagePrice: parseFloat(pos.average_price),
          currentPrice,
          unrealizedPnl: parseFloat(pos.unrealized_pnl),
          realizedPnl: parseFloat(pos.realized_pnl),
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
    if (!this.address) {
      return 0;
    }

    this.logger.warn('Balance check not fully implemented - requires Polygon RPC connection');
    return 0;
  }

  async getMarketResolution(contractId: string): Promise<MarketResolution | null> {
    try {
      const market = await this.getContract(contractId);
      if (!market || !market.metadata?.resolved) {
        return null;
      }

      const resolvedOutcome = market.metadata.resolvedOutcome as string | undefined;
      const outcomes = market.metadata.outcomes as string[] | undefined;
      let outcome: 'yes' | 'no' | 'invalid' = 'invalid';
      let settlementPrice = 0;

      if (resolvedOutcome === outcomes?.[0]) {
        outcome = 'yes';
        settlementPrice = 1;
      } else if (resolvedOutcome === outcomes?.[1]) {
        outcome = 'no';
        settlementPrice = 0;
      }

      return {
        contractId,
        resolved: true,
        outcome,
        settlementPrice,
        timestamp: new Date(),
      };
    } catch (error) {
      this.logger.error('Failed to fetch market resolution', {
        contractId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async getOrderBook(contractId: string, side: 'yes' | 'no'): Promise<unknown> {
    try {
      const market = await this.getContract(contractId);
      if (!market) {
        return null;
      }

      const clobTokenIds = market.metadata?.clobTokenIds as string[] | undefined;
      const tokenId = clobTokenIds?.[side === 'yes' ? 0 : 1];
      if (!tokenId) {
        return null;
      }

      const response = await withRateLimit(this.rateLimiter, () =>
        this.client.get(`/orderbook`, {
          params: {
            market: contractId,
            asset_id: tokenId,
          },
        }),
      );

      return response.data;
    } catch (error) {
      this.logger.error('Failed to fetch order book', {
        contractId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private mapOrderStatus(polyStatus: string): 'pending' | 'filled' | 'cancelled' | 'failed' {
    switch (polyStatus.toUpperCase()) {
      case 'OPEN':
      case 'PENDING':
        return 'pending';
      case 'FILLED':
      case 'MATCHED':
        return 'filled';
      case 'CANCELLED':
      case 'CANCELED':
        return 'cancelled';
      default:
        return 'failed';
    }
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
