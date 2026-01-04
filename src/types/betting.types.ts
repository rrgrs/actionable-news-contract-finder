/**
 * Market represents a prediction market question/event
 * One market can have multiple contracts (betting options)
 */
export interface Market {
  id: string;
  platform: string;
  eventTicker: string; // Platform-specific grouping key (e.g., "KXSPOTIFY2D")
  seriesTicker?: string; // Higher-level grouping (e.g., "KXSPOTIFY")
  title: string; // The market question
  url: string;
  category?: string;
  endDate?: Date;
  metadata?: Record<string, unknown>;
}

/**
 * MarketWithContracts is a Market with all its betting options loaded
 */
export interface MarketWithContracts extends Market {
  contracts: ContractOutcome[];
}

/**
 * ContractOutcome represents an individual betting option within a Market
 * (e.g., "Bitcoin above $97,750" or "Weren't for the Wind")
 */
export interface ContractOutcome {
  id: string;
  contractTicker: string; // Platform's unique ID (e.g., "KXBTC-26JAN0109-T97749.99")
  platform: string;
  title: string; // The betting option
  yesPrice: number;
  noPrice: number;
  volume: number;
  liquidity: number;
  metadata?: Record<string, unknown>;
}

/**
 * Contract is the flat structure returned by betting platform APIs
 * Contains both market-level and contract-level data mixed together
 * Used as input for sync service which will split into Market + ContractOutcome
 */
export interface Contract {
  id: string;
  platform: string;
  title: string;
  yesPrice: number;
  noPrice: number;
  volume: number;
  liquidity: number;
  endDate: Date;
  tags: string[];
  url: string;
  metadata?: Record<string, unknown>;
}

/**
 * MatchedMarket is returned by the matching service when a news item matches a market
 */
export interface MatchedMarket {
  market: Market;
  contracts: ContractOutcome[];
  similarity: number;
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

/**
 * BettingPlatform interface for platform plugins
 * Returns flat Contract[] which sync service will group into Market + ContractOutcome
 */
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
