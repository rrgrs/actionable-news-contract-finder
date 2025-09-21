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
  platform: string;
  title: string;
  description: string;
  yesPrice: number;
  noPrice: number;
  volume: number;
  liquidity: number;
  endDate: Date;
  tags: string[];
  url: string;
  metadata?: Record<string, unknown>;
}

export interface Order {
  contractId: string;
  platform: string;
  side: 'yes' | 'no';
  quantity: number;
  orderType: 'market' | 'limit';
  limitPrice?: number;
}

export interface OrderStatus {
  orderId: string;
  status: 'pending' | 'filled' | 'cancelled' | 'failed';
  filledQuantity: number;
  averagePrice: number;
  timestamp: Date;
}

export interface Position {
  contractId: string;
  platform: string;
  quantity: number;
  side: 'yes' | 'no';
  averagePrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
}

export interface MarketResolution {
  contractId: string;
  resolved: boolean;
  outcome: 'yes' | 'no' | 'invalid';
  settlementPrice: number;
  timestamp: Date;
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
  getAvailableContracts(): Promise<Contract[]>;
  getContract(contractId: string): Promise<Contract | null>;
  placeOrder(order: Order): Promise<OrderStatus>;
  cancelOrder(orderId: string): Promise<boolean>;
  getPositions(): Promise<Position[]>;
  getBalance(): Promise<number>;
  getMarketResolution(contractId: string): Promise<MarketResolution | null>;
  isHealthy(): Promise<boolean>;
  destroy(): Promise<void>;
}

export interface BettingPlatformPlugin {
  create(config: BettingPlatformConfig): BettingPlatform;
}
