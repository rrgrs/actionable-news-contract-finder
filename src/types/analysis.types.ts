export interface ParsedNewsInsight {
  originalNewsId: string;
  summary: string;
  entities: Entity[];
  events: Event[];
  predictions: Prediction[];
  sentiment: Sentiment;
  relevanceScore: number;
  suggestedActions: SuggestedAction[];
  metadata?: Record<string, unknown>;
}

export interface Entity {
  type: 'person' | 'organization' | 'location' | 'product' | 'event' | 'other';
  name: string;
  confidence: number;
  context?: string;
}

export interface Event {
  type: string;
  description: string;
  date?: Date;
  probability?: number;
  impact?: 'low' | 'medium' | 'high';
}

export interface Prediction {
  outcome: string;
  probability: number;
  timeframe?: string;
  confidence: number;
  reasoning?: string;
}

export interface Sentiment {
  overall: number;
  positive: number;
  negative: number;
  neutral: number;
}

export interface SuggestedAction {
  type: 'bet' | 'monitor' | 'research' | 'ignore';
  description: string;
  urgency: 'low' | 'medium' | 'high';
  relatedMarketQuery?: string;
  confidence: number;
}

export interface LLMProviderConfig {
  name: string;
  apiKey?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  baseUrl?: string;
  customConfig?: Record<string, unknown>;
}

export interface LLMProvider {
  name: string;
  initialize(config: LLMProviderConfig): Promise<void>;
  generateCompletion(prompt: string, systemPrompt?: string): Promise<string>;
  generateStructuredOutput<T>(prompt: string, schema: unknown, systemPrompt?: string): Promise<T>;
  isHealthy(): Promise<boolean>;
  destroy(): Promise<void>;
}

export interface LLMProviderPlugin {
  create(config: LLMProviderConfig): LLMProvider;
}

export interface NewsParser {
  parseNews(
    newsItem: import('./news.types').NewsItem,
    llmProvider: LLMProvider,
  ): Promise<ParsedNewsInsight>;
  batchParseNews(
    newsItems: import('./news.types').NewsItem[],
    llmProvider: LLMProvider,
  ): Promise<ParsedNewsInsight[]>;
}

export interface ContractValidation {
  contractId: string;
  newsInsightId: string;
  isRelevant: boolean;
  relevanceScore: number;
  matchedEntities: string[];
  matchedEvents: string[];
  reasoning: string;
  suggestedPosition?: 'buy' | 'sell' | 'hold';
  suggestedConfidence: number;
  risks: string[];
  opportunities: string[];
}

export interface ContractValidator {
  validateContract(
    contract: import('./betting.types').Contract,
    newsInsight: ParsedNewsInsight,
    llmProvider: LLMProvider,
  ): Promise<ContractValidation>;

  batchValidateContracts(
    contracts: import('./betting.types').Contract[],
    newsInsight: ParsedNewsInsight,
    llmProvider: LLMProvider,
  ): Promise<ContractValidation[]>;
}
