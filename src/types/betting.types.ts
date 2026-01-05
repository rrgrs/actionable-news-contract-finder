/**
 * Market represents a prediction market question/event
 * One market can have multiple contracts (betting options)
 */
export interface Market {
  id: string; // Platform's event ticker (e.g., "KXSPOTIFY2D")
  platform: string;
  seriesTicker?: string; // Higher-level grouping (e.g., "KXSPOTIFY")
  title: string; // The market question
  subtitle?: string;
  url: string;
  category?: string;
  endDate?: Date;
}

/**
 * MarketWithContracts is a Market with all its betting options loaded
 */
export interface MarketWithContracts extends Market {
  contracts: Contract[];
}

/**
 * Contract represents an individual betting option within a Market
 * (e.g., "Bitcoin above $97,750" or "Weren't for the Wind")
 */
export interface Contract {
  id: string; // Platform's contract/market ticker
  title: string; // The betting option (e.g., yes_sub_title)
  yesPrice: number;
  noPrice: number;
  volume: number;
  liquidity: number;
  endDate?: Date;
}

/**
 * MatchedMarket is returned by the matching service when a news item matches a market
 */
export interface MatchedMarket {
  market: MarketWithContracts;
  similarity: number;
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
 * Returns MarketWithContracts[] - markets with their nested contracts
 */
export interface BettingPlatform {
  name: string;
  initialize(config: BettingPlatformConfig): Promise<void>;
  getMarkets(): Promise<MarketWithContracts[]>;
  isHealthy(): Promise<boolean>;
  destroy(): Promise<void>;
}

export interface BettingPlatformPlugin {
  create(config: BettingPlatformConfig): BettingPlatform;
}
