import {
  BettingPlatform,
  BettingPlatformConfig,
  BettingPlatformPlugin,
  Contract,
  Position,
  Order,
  OrderStatus,
  MarketResolution,
} from '../../../types';

export class MockBettingPlatform implements BettingPlatform {
  name: string;
  private isInitialized = false;
  private positions: Map<string, Position> = new Map();
  private orders: Map<string, OrderStatus> = new Map();
  private contracts: Map<string, Contract> = new Map();

  constructor(config: BettingPlatformConfig) {
    this.name = config.name;
  }

  async initialize(config: BettingPlatformConfig): Promise<void> {
    this.isInitialized = true;

    // Create some mock contracts
    const mockContracts: Contract[] = [
      {
        id: `contract-fed-${Date.now()}`,
        platform: this.name,
        title: 'Will the Fed cut rates in Q1 2025?',
        yesPrice: 0.65,
        noPrice: 0.35,
        volume: 250000,
        liquidity: 50000,
        endDate: new Date('2025-03-31'),
        tags: ['economics', 'federal-reserve'],
        url: 'https://mock.platform/markets/fed-rates-q1',
        metadata: {
          category: 'economics',
          previousPrice: 0.62,
        },
      },
      {
        id: `contract-tesla-${Date.now()}`,
        platform: this.name,
        title: 'Tesla stock above $400 by end of 2025?',
        yesPrice: 0.45,
        noPrice: 0.55,
        volume: 180000,
        liquidity: 35000,
        endDate: new Date('2025-12-31'),
        tags: ['stocks', 'tesla'],
        url: 'https://mock.platform/markets/tesla-400',
        metadata: {
          category: 'stocks',
          previousPrice: 0.48,
        },
      },
    ];

    mockContracts.forEach((contract) => {
      this.contracts.set(contract.id, contract);
    });

    console.log(`MockBettingPlatform initialized: ${config.name}`);
  }

  async getAvailableContracts(): Promise<Contract[]> {
    if (!this.isInitialized) {
      throw new Error('Platform not initialized');
    }
    return Array.from(this.contracts.values());
  }

  async getContract(contractId: string): Promise<Contract | null> {
    if (!this.isInitialized) {
      throw new Error('Platform not initialized');
    }
    return this.contracts.get(contractId) || null;
  }

  async placeOrder(order: Order): Promise<OrderStatus> {
    if (!this.isInitialized) {
      throw new Error('Platform not initialized');
    }

    const contract = await this.getContract(order.contractId);
    if (!contract) {
      throw new Error(`Contract ${order.contractId} not found`);
    }

    const orderId = `order-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const price = order.limitPrice || (order.side === 'yes' ? contract.yesPrice : contract.noPrice);

    const orderStatus: OrderStatus = {
      orderId,
      status: 'filled',
      filledQuantity: order.quantity,
      averagePrice: price,
      timestamp: new Date(),
    };

    this.orders.set(orderId, orderStatus);

    // Create a position for this order
    const position: Position = {
      contractId: order.contractId,
      platform: this.name,
      quantity: order.quantity,
      side: order.side,
      averagePrice: price,
      currentPrice: order.side === 'yes' ? contract.yesPrice : contract.noPrice,
      unrealizedPnl: 0,
      realizedPnl: 0,
    };

    const positionKey = `${order.contractId}-${order.side}`;
    this.positions.set(positionKey, position);

    console.log(
      `Mock order placed: ${order.quantity} ${order.side} contracts of ${order.contractId} at ${price}`,
    );

    return orderStatus;
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    if (!this.isInitialized) {
      throw new Error('Platform not initialized');
    }

    const order = this.orders.get(orderId);
    if (!order) {
      return false;
    }

    order.status = 'cancelled';
    console.log(`Mock order cancelled: ${orderId}`);
    return true;
  }

  async getPositions(): Promise<Position[]> {
    if (!this.isInitialized) {
      throw new Error('Platform not initialized');
    }
    return Array.from(this.positions.values());
  }

  async getBalance(): Promise<number> {
    if (!this.isInitialized) {
      throw new Error('Platform not initialized');
    }
    // Return a mock balance
    return 10000; // $10,000
  }

  async getMarketResolution(_contractId: string): Promise<MarketResolution | null> {
    if (!this.isInitialized) {
      throw new Error('Platform not initialized');
    }

    // Return null for mock platform (no resolved markets)
    return null;
  }

  async isHealthy(): Promise<boolean> {
    return this.isInitialized;
  }

  async destroy(): Promise<void> {
    this.positions.clear();
    this.orders.clear();
    this.contracts.clear();
    this.isInitialized = false;
    console.log('MockBettingPlatform destroyed');
  }
}

export const MockBettingPlatformPlugin: BettingPlatformPlugin = {
  create: (config: BettingPlatformConfig) => {
    return new MockBettingPlatform(config);
  },
};
