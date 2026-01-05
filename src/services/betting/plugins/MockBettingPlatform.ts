import {
  BettingPlatform,
  BettingPlatformConfig,
  BettingPlatformPlugin,
  MarketWithContracts,
} from '../../../types';

export class MockBettingPlatform implements BettingPlatform {
  name: string;
  private isInitialized = false;
  private markets: MarketWithContracts[] = [];

  constructor(config: BettingPlatformConfig) {
    this.name = config.name;
  }

  async initialize(_config: BettingPlatformConfig): Promise<void> {
    this.isInitialized = true;

    // Create some mock markets with contracts
    this.markets = [
      {
        id: 'fed-rates-q1-2025',
        platform: this.name,
        title: 'Will the Fed cut rates in Q1 2025?',
        url: `https://mock-betting.com/markets/fed-rates-q1-2025`,
        category: 'Economics',
        endDate: new Date('2025-03-31'),
        contracts: [
          {
            id: 'fed-rates-q1-2025-yes',
            title: 'Yes',
            yesPrice: 0.65,
            noPrice: 0.35,
            volume: 250000,
            liquidity: 50000,
          },
        ],
      },
      {
        id: 'tesla-400-2025',
        platform: this.name,
        title: 'Tesla stock above $400 by end of 2025?',
        url: `https://mock-betting.com/markets/tesla-400-2025`,
        category: 'Stocks',
        endDate: new Date('2025-12-31'),
        contracts: [
          {
            id: 'tesla-400-2025-yes',
            title: 'Yes',
            yesPrice: 0.45,
            noPrice: 0.55,
            volume: 180000,
            liquidity: 35000,
          },
        ],
      },
    ];

    console.log(`MockBettingPlatform initialized: ${this.name}`);
  }

  async getMarkets(): Promise<MarketWithContracts[]> {
    if (!this.isInitialized) {
      throw new Error('Platform not initialized');
    }
    return this.markets;
  }

  async isHealthy(): Promise<boolean> {
    return this.isInitialized;
  }

  async destroy(): Promise<void> {
    this.markets = [];
    this.isInitialized = false;
    console.log('MockBettingPlatform destroyed');
  }
}

export const MockBettingPlatformPlugin: BettingPlatformPlugin = {
  create: (config: BettingPlatformConfig) => {
    return new MockBettingPlatform(config);
  },
};
