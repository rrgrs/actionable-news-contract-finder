import {
  BettingPlatform,
  BettingPlatformConfig,
  BettingPlatformPlugin,
  Market,
  Contract,
  Position,
} from '../../../types';

export class MockBettingPlatform implements BettingPlatform {
  name: string;
  private isInitialized = false;
  private positions: Map<string, Position> = new Map();

  constructor(config: BettingPlatformConfig) {
    this.name = config.name;
  }

  async initialize(config: BettingPlatformConfig): Promise<void> {
    this.isInitialized = true;
    console.log(`MockBettingPlatform initialized: ${config.name}`);
  }

  async searchMarkets(query: string): Promise<Market[]> {
    if (!this.isInitialized) {
      throw new Error('Platform not initialized');
    }

    const mockMarkets: Market[] = [
      {
        id: `market-fed-${Date.now()}`,
        platform: this.name,
        title: 'Will the Fed cut rates in Q1 2025?',
        description:
          'This market resolves YES if the Federal Reserve cuts interest rates by any amount in Q1 2025',
        url: 'https://mock.platform/markets/fed-rates-q1',
        createdAt: new Date(Date.now() - 86400000),
        expiresAt: new Date('2025-03-31'),
        volume: 250000,
        liquidity: 50000,
        metadata: { category: 'economics' },
      },
      {
        id: `market-tesla-${Date.now()}`,
        platform: this.name,
        title: 'Tesla stock above $400 by end of 2025?',
        description: 'Resolves YES if TSLA closes above $400 on December 31, 2025',
        url: 'https://mock.platform/markets/tesla-400',
        createdAt: new Date(Date.now() - 172800000),
        expiresAt: new Date('2025-12-31'),
        volume: 180000,
        liquidity: 35000,
        metadata: { category: 'stocks' },
      },
    ];

    return mockMarkets.filter(
      (m) =>
        m.title.toLowerCase().includes(query.toLowerCase()) ||
        m.description.toLowerCase().includes(query.toLowerCase()),
    );
  }

  async getMarket(marketId: string): Promise<Market> {
    if (!this.isInitialized) {
      throw new Error('Platform not initialized');
    }

    const markets = await this.searchMarkets('');
    const market = markets.find((m) => m.id === marketId);
    if (!market) {
      throw new Error(`Market ${marketId} not found`);
    }
    return market;
  }

  async getContracts(marketId: string): Promise<Contract[]> {
    if (!this.isInitialized) {
      throw new Error('Platform not initialized');
    }

    return [
      {
        id: `${marketId}-yes`,
        marketId,
        platform: this.name,
        title: 'YES',
        description: 'This contract pays $1 if the outcome is YES',
        outcome: 'YES',
        currentPrice: 0.65,
        previousPrice: 0.62,
        volume: 125000,
        expiresAt: new Date('2025-03-31'),
        metadata: { lastUpdate: new Date() },
      },
      {
        id: `${marketId}-no`,
        marketId,
        platform: this.name,
        title: 'NO',
        description: 'This contract pays $1 if the outcome is NO',
        outcome: 'NO',
        currentPrice: 0.35,
        previousPrice: 0.38,
        volume: 125000,
        expiresAt: new Date('2025-03-31'),
        metadata: { lastUpdate: new Date() },
      },
    ];
  }

  async getContract(contractId: string): Promise<Contract> {
    if (!this.isInitialized) {
      throw new Error('Platform not initialized');
    }

    const marketId = contractId.split('-').slice(0, -1).join('-');
    const contracts = await this.getContracts(marketId);
    const contract = contracts.find((c) => c.id === contractId);
    if (!contract) {
      throw new Error(`Contract ${contractId} not found`);
    }
    return contract;
  }

  async placeOrder(
    contractId: string,
    side: 'buy' | 'sell',
    quantity: number,
    price?: number,
  ): Promise<Position> {
    if (!this.isInitialized) {
      throw new Error('Platform not initialized');
    }

    const contract = await this.getContract(contractId);
    const position: Position = {
      id: `pos-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      contractId,
      platform: this.name,
      side,
      quantity,
      price: price || contract.currentPrice,
      timestamp: new Date(),
      status: 'filled',
      metadata: { mock: true },
    };

    this.positions.set(position.id, position);
    console.log(
      `Mock order placed: ${side} ${quantity} contracts of ${contractId} at ${position.price}`,
    );
    return position;
  }

  async getPosition(positionId: string): Promise<Position> {
    if (!this.isInitialized) {
      throw new Error('Platform not initialized');
    }

    const position = this.positions.get(positionId);
    if (!position) {
      throw new Error(`Position ${positionId} not found`);
    }
    return position;
  }

  async getPositions(): Promise<Position[]> {
    if (!this.isInitialized) {
      throw new Error('Platform not initialized');
    }
    return Array.from(this.positions.values());
  }

  async cancelOrder(positionId: string): Promise<void> {
    if (!this.isInitialized) {
      throw new Error('Platform not initialized');
    }

    const position = this.positions.get(positionId);
    if (!position) {
      throw new Error(`Position ${positionId} not found`);
    }

    position.status = 'cancelled';
    console.log(`Mock order cancelled: ${positionId}`);
  }

  async isHealthy(): Promise<boolean> {
    return this.isInitialized;
  }

  async destroy(): Promise<void> {
    this.positions.clear();
    this.isInitialized = false;
    console.log('MockBettingPlatform destroyed');
  }
}

export const MockBettingPlatformPlugin: BettingPlatformPlugin = {
  create(config: BettingPlatformConfig): BettingPlatform {
    return new MockBettingPlatform(config);
  },
};
