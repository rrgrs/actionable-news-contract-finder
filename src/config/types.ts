export interface ServiceConfig {
  name: string;
  fileName: string;
  config: Record<string, unknown>;
}

export type AlertType = 'none' | 'email' | 'system' | 'both';

export interface AlertConfig {
  type: AlertType;
  emailConfig?: {
    to: string[];
    from: string;
    smtpHost?: string;
    smtpPort?: number;
    smtpUser?: string;
    smtpPass?: string;
  };
  minConfidenceThreshold?: number; // Only alert if confidence is above this
  cooldownMinutes?: number; // Avoid alerting too frequently for the same market
}

export interface BetSyncConfig {
  syncIntervalMs: number; // How often to sync bets from platforms (default: 300000 = 5 min)
  embeddingBatchSize: number; // Batch size for embedding generation (default: 100)
}

export interface BetMatchingConfig {
  topN: number; // Number of top matching bets to return (default: 50)
  minSimilarity?: number; // Optional minimum similarity threshold
}

export interface EmbeddingProviderConfig {
  apiKey: string;
  model?: string; // Default: text-embedding-004
  batchSize?: number; // Default: 100
  requestDelayMs?: number; // Default: 100
}

export interface AppConfig {
  newsServices: ServiceConfig[];
  bettingPlatforms: ServiceConfig[];
  llmProviders: ServiceConfig[];
  orchestrator: {
    pollIntervalMs: number;
    minRelevanceScore: number;
    minConfidenceScore: number;
    maxPositionsPerContract: number;
    dryRun: boolean;
    placeBets: boolean; // New: control whether to actually place bets
  };
  betSync: BetSyncConfig; // Bet synchronization config
  betMatching: BetMatchingConfig; // Bet matching config
  embedding: EmbeddingProviderConfig; // Embedding provider config
  alerts: AlertConfig; // Alert configuration
  logLevel: string;
  useV2Orchestrator: boolean; // Use embedding-based matching (V2) instead of legacy search-based
}

export interface ServicePluginInfo {
  fileName: string;
  pluginName: string;
  createFunction: string;
}
