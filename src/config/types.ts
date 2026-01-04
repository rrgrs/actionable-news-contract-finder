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

export interface EmbeddingProviderConfig {
  apiKey: string;
  model?: string; // Default: text-embedding-004
  batchSize?: number; // Default: 100
  requestDelayMs?: number; // Default: 100
}

export interface MatchingConfig {
  topN: number; // Number of top matching markets to return per article
  minSimilarity?: number; // Optional minimum similarity threshold
}

export interface ValidationConfig {
  minConfidenceScore: number; // Min confidence to send alerts
  dryRun: boolean; // Simulate actions only
  placeBets: boolean; // Actually place bets (requires dryRun=false)
}

export interface AppConfig {
  newsServices: ServiceConfig[];
  bettingPlatforms: ServiceConfig[];
  llmProviders: ServiceConfig[];
  embedding: EmbeddingProviderConfig;
  matching: MatchingConfig;
  validation: ValidationConfig;
  alerts: AlertConfig;
  logLevel: string;
}

export interface ServicePluginInfo {
  fileName: string;
  pluginName: string;
  createFunction: string;
}
