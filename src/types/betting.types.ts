export interface Market {
  id: string;
  platform: string;
  title: string;
  description: string;
  url: string;
  createdAt: Date;
  expiresAt?: Date;
  volume?: number;
  liquidity?: number;
  metadata?: Record<string, unknown>;
}

export interface Contract {
  id: string;
  marketId: string;
  platform: string;
  title: string;
  description: string;
  outcome: string;
  currentPrice: number;
  previousPrice?: number;
  volume?: number;
  expiresAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface Position {
  id: string;
  contractId: string;
  platform: string;
  side: 'buy' | 'sell';
  quantity: number;
  price: number;
  timestamp: Date;
  status: 'pending' | 'filled' | 'cancelled' | 'failed';
  metadata?: Record<string, unknown>;
}

export interface BettingPlatformConfig {
  name: string;
  apiKey?: string;
  apiSecret?: string;
  baseUrl?: string;
  testMode?: boolean;
  customConfig?: Record<string, unknown>;
}

export interface BettingPlatform {
  name: string;
  initialize(config: BettingPlatformConfig): Promise<void>;
  searchMarkets(query: string): Promise<Market[]>;
  getMarket(marketId: string): Promise<Market>;
  getContracts(marketId: string): Promise<Contract[]>;
  getContract(contractId: string): Promise<Contract>;
  placeOrder(
    contractId: string,
    side: 'buy' | 'sell',
    quantity: number,
    price?: number,
  ): Promise<Position>;
  getPosition(positionId: string): Promise<Position>;
  getPositions(): Promise<Position[]>;
  cancelOrder(positionId: string): Promise<void>;
  isHealthy(): Promise<boolean>;
  destroy(): Promise<void>;
}

export interface BettingPlatformPlugin {
  create(config: BettingPlatformConfig): BettingPlatform;
}
