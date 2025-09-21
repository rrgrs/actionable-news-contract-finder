import {
  NewsService,
  BettingPlatform,
  LLMProvider,
  NewsItem,
  ParsedNewsInsight,
  Contract,
  ContractValidation,
  Position,
} from '../../types';
import { NewsParserService } from '../analysis/NewsParserService';
import { ContractValidatorService } from '../analysis/ContractValidatorService';
import { AlertService, AlertPayload } from '../alerts/AlertService';
import { AlertConfig } from '../../config/types';

export interface OrchestratorConfig {
  pollIntervalMs: number;
  minRelevanceScore: number;
  minConfidenceScore: number;
  maxPositionsPerContract: number;
  dryRun: boolean;
  placeBets: boolean;
}

export interface ProcessingResult {
  newsProcessed: number;
  insightsGenerated: number;
  marketsSearched: number;
  contractsValidated: number;
  positionsCreated: number;
  alertsSent: number;
  errors: string[];
}

export class OrchestratorService {
  private newsServices: NewsService[] = [];
  private bettingPlatforms: BettingPlatform[] = [];
  private llmProviders: LLMProvider[] = [];
  private newsParser: NewsParserService;
  private contractValidator: ContractValidatorService;
  private alertService?: AlertService;
  private config: OrchestratorConfig;
  private isRunning = false;
  private pollInterval?: NodeJS.Timeout;
  private processedNewsIds = new Set<string>();
  private activePositions = new Map<string, Position[]>();

  constructor(config: OrchestratorConfig, alertConfig?: AlertConfig) {
    this.config = config;
    this.newsParser = new NewsParserService();
    this.contractValidator = new ContractValidatorService();

    if (alertConfig && alertConfig.type !== 'none') {
      this.alertService = new AlertService(alertConfig);
    }
  }

  addNewsService(service: NewsService): void {
    this.newsServices.push(service);
    console.log(`Added news service: ${service.name}`);
  }

  addBettingPlatform(platform: BettingPlatform): void {
    this.bettingPlatforms.push(platform);
    console.log(`Added betting platform: ${platform.name}`);
  }

  addLLMProvider(provider: LLMProvider): void {
    this.llmProviders.push(provider);
    console.log(`Added LLM provider: ${provider.name}`);
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('Orchestrator already running');
      return;
    }

    console.log('Starting orchestrator service...');

    // Test alert connection if configured
    if (this.alertService) {
      console.log('Testing alert service connection...');
      const alertTestSuccess = await this.alertService.testConnection();
      if (!alertTestSuccess) {
        console.warn('Alert service test failed, but continuing...');
      }
    }

    // Display bet placement configuration
    if (!this.config.placeBets) {
      console.log('⚠️  BET PLACEMENT IS DISABLED - Will only find and alert on opportunities');
    } else if (this.config.dryRun) {
      console.log('📝 DRY RUN MODE - Will simulate bet placement without real orders');
    } else {
      console.log('💰 LIVE MODE - Will place real bets when opportunities are found');
    }

    this.isRunning = true;

    await this.runCycle();

    this.pollInterval = setInterval(async () => {
      if (this.isRunning) {
        await this.runCycle();
      }
    }, this.config.pollIntervalMs);

    console.log(`Orchestrator started with ${this.config.pollIntervalMs}ms poll interval`);
  }

  async stop(): Promise<void> {
    console.log('Stopping orchestrator service...');
    this.isRunning = false;

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
    }

    console.log('Orchestrator stopped');
  }

  private async runCycle(): Promise<ProcessingResult> {
    console.log(`\n=== Starting processing cycle at ${new Date().toISOString()} ===`);

    const result: ProcessingResult = {
      newsProcessed: 0,
      insightsGenerated: 0,
      marketsSearched: 0,
      contractsValidated: 0,
      positionsCreated: 0,
      alertsSent: 0,
      errors: [],
    };

    try {
      const allNews = await this.fetchAllNews();
      result.newsProcessed = allNews.length;
      console.log(`Fetched ${allNews.length} news items`);

      if (allNews.length === 0) {
        console.log('No news to process');
        return result;
      }

      const insights = await this.parseNews(allNews);
      result.insightsGenerated = insights.length;
      console.log(`Generated ${insights.length} insights`);

      for (const insight of insights) {
        if (insight.relevanceScore < this.config.minRelevanceScore) {
          console.log(`Skipping low relevance insight (score: ${insight.relevanceScore})`);
          continue;
        }

        // Find relevant betting opportunities
        for (const action of insight.suggestedActions) {
          if (action.type !== 'bet' || !action.relatedMarketQuery) {
            continue;
          }

          for (const platform of this.bettingPlatforms) {
            try {
              const markets = await platform.searchMarkets(action.relatedMarketQuery);
              result.marketsSearched += markets.length;

              for (const market of markets.slice(0, 3)) {
                const contracts = await platform.getContracts(market.id);
                const contractValidations = await this.contractValidator.batchValidateContracts(
                  contracts,
                  insight,
                  this.llmProviders[0],
                );
                result.contractsValidated += contractValidations.length;

                // Process validated contracts
                for (const validation of contractValidations) {
                  if (
                    validation.isRelevant &&
                    validation.suggestedConfidence >= this.config.minConfidenceScore &&
                    validation.suggestedPosition !== 'hold'
                  ) {
                    const contract = contracts.find((c) => c.id === validation.contractId);
                    if (!contract) {
                      continue;
                    }

                    const newsItem = allNews.find((n) => n.id === insight.originalNewsId);

                    // Send alert if configured
                    if (this.alertService && newsItem) {
                      const alertPayload: AlertPayload = {
                        newsTitle: newsItem.title,
                        newsUrl: newsItem.url,
                        marketTitle: market.title,
                        marketUrl: market.url || '',
                        contractTitle: contract.title,
                        suggestedPosition: (validation.suggestedPosition || 'buy') as
                          | 'buy'
                          | 'sell',
                        confidence: validation.suggestedConfidence,
                        currentPrice: contract.currentPrice || 0,
                        reasoning: validation.reasoning,
                        timestamp: new Date(),
                      };

                      try {
                        await this.alertService.sendAlert(alertPayload);
                        result.alertsSent++;
                      } catch (error) {
                        console.error('Failed to send alert:', error);
                        result.errors.push(`Alert failed: ${error}`);
                      }
                    }

                    // Handle bet placement
                    const quantity = this.calculateOrderQuantity(validation, contract);

                    if (!this.config.placeBets) {
                      console.log(
                        `  📊 [BETS DISABLED] Found opportunity: ${validation.suggestedPosition} ${quantity} shares of "${contract.title}" at $${contract.currentPrice}`,
                      );
                      console.log(`     Market: ${market.title}`);
                      console.log(
                        `     Confidence: ${Math.round(validation.suggestedConfidence * 100)}%`,
                      );
                      console.log(`     Reasoning: ${validation.reasoning}`);
                      result.positionsCreated++; // Count as found opportunity
                    } else if (this.config.dryRun) {
                      console.log(
                        `  📝 [DRY RUN] Would place ${validation.suggestedPosition} order for ${quantity} shares at $${contract.currentPrice}`,
                      );
                      result.positionsCreated++;
                    } else {
                      try {
                        const position = await platform.placeOrder(
                          contract.id,
                          validation.suggestedPosition || 'buy',
                          quantity,
                          contract.currentPrice,
                        );

                        console.log(
                          `  ✅ Placed ${validation.suggestedPosition} order for ${quantity} shares`,
                        );
                        result.positionsCreated++;

                        // Track position
                        if (position) {
                          const positions = this.activePositions.get(contract.id) || [];
                          positions.push(position);
                          this.activePositions.set(contract.id, positions);
                        }
                      } catch (error) {
                        console.error(`  ❌ Failed to place order:`, error);
                        result.errors.push(`Order placement failed: ${error}`);
                      }
                    }
                  }
                }
              }
            } catch (error) {
              console.error(`Error searching markets on ${platform.name}:`, error);
              result.errors.push(`Market search failed on ${platform.name}: ${error}`);
            }
          }
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      result.errors.push(errorMsg);
      console.error('Error in processing cycle:', errorMsg);
    }

    console.log(`=== Cycle complete: ${JSON.stringify(result)} ===\n`);
    return result;
  }

  private async fetchAllNews(): Promise<NewsItem[]> {
    const allNews: NewsItem[] = [];

    for (const service of this.newsServices) {
      try {
        const news = await service.fetchLatestNews();
        // Filter out already processed news
        const newItems = news.filter((item) => !this.processedNewsIds.has(item.id));
        allNews.push(...newItems);

        // Mark as processed
        newItems.forEach((item) => this.processedNewsIds.add(item.id));
      } catch (error) {
        console.error(`Error fetching news from ${service.name}:`, error);
      }
    }

    // Clean up old processed IDs (keep only last 1000)
    if (this.processedNewsIds.size > 1000) {
      const idsArray = Array.from(this.processedNewsIds);
      this.processedNewsIds = new Set(idsArray.slice(-1000));
    }

    return allNews.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
  }

  private async parseNews(newsItems: NewsItem[]): Promise<ParsedNewsInsight[]> {
    if (this.llmProviders.length === 0) {
      console.warn('No LLM providers available');
      return [];
    }

    const insights: ParsedNewsInsight[] = [];
    const llmProvider = this.llmProviders[0];

    for (const newsItem of newsItems) {
      try {
        const insight = await this.newsParser.parseNews(newsItem, llmProvider);
        insights.push(insight);
      } catch (error) {
        console.error(`Error parsing news item ${newsItem.id}:`, error);
      }
    }

    return insights;
  }

  private calculateOrderQuantity(validation: ContractValidation, _contract: Contract): number {
    const baseQuantity = 10;
    const confidenceMultiplier = validation.suggestedConfidence;
    const relevanceMultiplier = validation.relevanceScore;

    return Math.floor(baseQuantity * confidenceMultiplier * relevanceMultiplier);
  }

  async getStatus(): Promise<{
    isRunning: boolean;
    services: { news: number; betting: number; llm: number };
    config: OrchestratorConfig;
    alertsEnabled: boolean;
    processedNewsCount: number;
    activePositionsCount: number;
  }> {
    return {
      isRunning: this.isRunning,
      services: {
        news: this.newsServices.length,
        betting: this.bettingPlatforms.length,
        llm: this.llmProviders.length,
      },
      config: this.config,
      alertsEnabled: !!this.alertService,
      processedNewsCount: this.processedNewsIds.size,
      activePositionsCount: this.activePositions.size,
    };
  }
}
