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
  alerts: AlertConfig; // New: alert configuration
  logLevel: string;
}

export interface ServicePluginInfo {
  fileName: string;
  pluginName: string;
  createFunction: string;
}
