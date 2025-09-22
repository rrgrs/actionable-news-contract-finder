import {
  NewsService,
  BettingPlatform,
  LLMProvider,
  NewsItem,
  ParsedNewsInsight,
  Contract,
  ContractValidation,
  Position,
  Order,
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
  private isRunning = false;
  private processInterval: NodeJS.Timeout | null = null;
  private newsParser: NewsParserService;
  private contractValidator: ContractValidatorService;
  private alertService?: AlertService;
  private activePositions: Map<string, Position[]> = new Map();

  constructor(
    private config: OrchestratorConfig,
    private newsServices: NewsService[],
    private bettingPlatforms: BettingPlatform[],
    private llmProviders: LLMProvider[],
    alertConfig?: AlertConfig,
  ) {
    this.newsParser = new NewsParserService();
    this.contractValidator = new ContractValidatorService();

    if (alertConfig) {
      this.alertService = new AlertService(alertConfig);
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('OrchestratorService is already running');
      return;
    }

    this.isRunning = true;
    console.log('🚀 OrchestratorService started');
    console.log(`  Mode: ${this.config.dryRun ? 'DRY RUN' : 'LIVE'}`);
    console.log(`  Bet Placement: ${this.config.placeBets ? 'ENABLED' : 'DISABLED'}`);
    console.log(`  Poll interval: ${this.config.pollIntervalMs / 1000}s`);
    console.log(`  News services: ${this.newsServices.map((s) => s.name).join(', ')}`);
    console.log(`  Betting platforms: ${this.bettingPlatforms.map((p) => p.name).join(', ')}`);
    console.log(`  LLM providers: ${this.llmProviders.map((p) => p.name).join(', ')}`);
    console.log(`  Alerts: ${this.alertService ? 'ENABLED' : 'DISABLED'}`);

    // Process immediately
    await this.processLoop();

    // Then set up recurring interval
    this.processInterval = setInterval(() => {
      this.processLoop().catch((error) => {
        console.error('Error in processing loop:', error);
      });
    }, this.config.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      console.log('OrchestratorService is not running');
      return;
    }

    this.isRunning = false;
    if (this.processInterval) {
      clearInterval(this.processInterval);
      this.processInterval = null;
    }

    console.log('🛑 OrchestratorService stopped');
  }

  private async processLoop(): Promise<ProcessingResult> {
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
      console.log(`\n📰 Processing news at ${new Date().toISOString()}`);

      // Step 1: Fetch news from all sources
      const allNews = await this.fetchAllNews();
      result.newsProcessed = allNews.length;

      if (allNews.length === 0) {
        console.log('  No new news items found');
        return result;
      }

      console.log(`  Found ${allNews.length} news items`);

      // Step 2: Parse news for insights
      const insights = await this.parseNewsForInsights(allNews);
      result.insightsGenerated = insights.length;

      if (insights.length === 0) {
        console.log('  No actionable insights generated');
        return result;
      }

      console.log(`  Generated ${insights.length} actionable insights`);

      // Step 3: Search for relevant contracts
      for (const insight of insights) {
        // Only process insights with suggested trading actions
        const tradingActions = insight.suggestedActions.filter(
          (a) => a.type === 'bet' && a.relatedMarketQuery,
        );

        for (const action of tradingActions) {
          if (!action.relatedMarketQuery) {
            continue;
          }

          for (const platform of this.bettingPlatforms) {
            try {
              // Get available contracts from platform
              const allContracts = await platform.getAvailableContracts();

              // Filter contracts based on the search query
              const relevantContracts = allContracts
                .filter(
                  (contract) =>
                    contract.title
                      .toLowerCase()
                      .includes(action.relatedMarketQuery!.toLowerCase()) ||
                    contract.description
                      .toLowerCase()
                      .includes(action.relatedMarketQuery!.toLowerCase()),
                )
                .slice(0, 10); // Limit to 10 contracts

              result.marketsSearched += relevantContracts.length;

              if (relevantContracts.length > 0) {
                const contracts = relevantContracts;
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
                        marketTitle: contract.title,
                        marketUrl: contract.url || '',
                        contractTitle: contract.title,
                        suggestedPosition: (validation.suggestedPosition || 'buy') as
                          | 'buy'
                          | 'sell',
                        confidence: validation.suggestedConfidence,
                        currentPrice:
                          validation.suggestedPosition === 'buy'
                            ? contract.yesPrice
                            : contract.noPrice,
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
                    const currentPrice =
                      validation.suggestedPosition === 'buy' ? contract.yesPrice : contract.noPrice;

                    if (!this.config.placeBets) {
                      console.log(
                        `  📊 [BETS DISABLED] Found opportunity: ${validation.suggestedPosition} ${quantity} shares of "${contract.title}" at $${currentPrice}`,
                      );
                      console.log(`     Market: ${contract.title}`);
                      console.log(
                        `     Confidence: ${Math.round(validation.suggestedConfidence * 100)}%`,
                      );
                      console.log(`     Reasoning: ${validation.reasoning}`);
                      result.positionsCreated++; // Count as found opportunity
                    } else if (this.config.dryRun) {
                      console.log(
                        `  📝 [DRY RUN] Would place ${validation.suggestedPosition} order for ${quantity} shares at $${currentPrice}`,
                      );
                      result.positionsCreated++;
                    } else {
                      try {
                        const order: Order = {
                          contractId: contract.id,
                          platform: platform.name,
                          side: validation.suggestedPosition === 'buy' ? 'yes' : 'no',
                          quantity,
                          orderType: 'limit',
                          limitPrice: currentPrice,
                        };

                        const orderStatus = await platform.placeOrder(order);

                        console.log(
                          `  ✅ Placed ${validation.suggestedPosition} order for ${quantity} shares (Order ID: ${orderStatus.orderId})`,
                        );
                        result.positionsCreated++;

                        // Track order status
                        if (orderStatus) {
                          // Create a position from the order status
                          const position: Position = {
                            contractId: contract.id,
                            platform: platform.name,
                            quantity: orderStatus.filledQuantity,
                            side: validation.suggestedPosition === 'buy' ? 'yes' : 'no',
                            averagePrice: orderStatus.averagePrice,
                            currentPrice: currentPrice,
                            unrealizedPnl: 0,
                            realizedPnl: 0,
                          };
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
              console.error(`Failed to search markets on ${platform.name}:`, error);
              result.errors.push(`Market search failed on ${platform.name}: ${error}`);
            }
          }
        }
      }

      // Step 4: Monitor existing positions (if any)
      await this.monitorPositions();

      console.log(`  ✅ Processing complete:
    News processed: ${result.newsProcessed}
    Insights generated: ${result.insightsGenerated}
    Markets searched: ${result.marketsSearched}
    Contracts validated: ${result.contractsValidated}
    Positions created: ${result.positionsCreated}
    Alerts sent: ${result.alertsSent}`);

      if (result.errors.length > 0) {
        console.log(`  ⚠️ Errors encountered: ${result.errors.length}`);
        result.errors.forEach((error) => console.log(`    - ${error}`));
      }
    } catch (error) {
      console.error('Error in processing loop:', error);
      result.errors.push(`Processing loop error: ${error}`);
    }

    return result;
  }

  private async fetchAllNews(): Promise<NewsItem[]> {
    const allNews: NewsItem[] = [];

    for (const service of this.newsServices) {
      try {
        const news = await service.fetchLatestNews();
        allNews.push(...news);
      } catch (error) {
        console.error(`Failed to fetch news from ${service.name}:`, error);
      }
    }

    // Deduplicate by title similarity
    const seen = new Set<string>();
    return allNews.filter((item) => {
      const key = item.title
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .substring(0, 50);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  private async parseNewsForInsights(newsItems: NewsItem[]): Promise<ParsedNewsInsight[]> {
    if (!this.llmProviders[0]) {
      console.error('No LLM provider available');
      return [];
    }

    try {
      // Use batch processing to reduce API calls
      console.log(`  Using batched processing for ${newsItems.length} news items...`);
      const allInsights = await this.newsParser.batchParseNews(newsItems, this.llmProviders[0]);

      // Filter for actionable insights only
      const actionableInsights = allInsights.filter((insight) =>
        insight.suggestedActions.some(
          (a) => a.type === 'bet' && a.confidence >= this.config.minRelevanceScore,
        ),
      );

      console.log(
        `    Batch processing complete: ${actionableInsights.length} actionable insights from ${allInsights.length} total`,
      );
      return actionableInsights;
    } catch (error) {
      console.error('Batch processing failed, falling back to individual processing:', error);

      // Fallback to individual processing
      const insights: ParsedNewsInsight[] = [];
      for (const news of newsItems) {
        try {
          const insight = await this.newsParser.parseNews(news, this.llmProviders[0]);

          // Only keep insights that have actionable trading suggestions
          if (
            insight.suggestedActions.some(
              (a) => a.type === 'bet' && a.confidence >= this.config.minRelevanceScore,
            )
          ) {
            insights.push(insight);
          }
        } catch (error) {
          console.error(`Failed to parse news item "${news.title}":`, error);
        }
      }

      return insights;
    }
  }

  private calculateOrderQuantity(validation: ContractValidation, _contract: Contract): number {
    // Simple quantity calculation based on confidence
    const baseQuantity = 10; // Base order size
    const confidenceMultiplier = Math.floor(validation.suggestedConfidence * 5);
    return baseQuantity * confidenceMultiplier;
  }

  private async monitorPositions(): Promise<void> {
    if (this.activePositions.size === 0) {
      return;
    }

    console.log(`  📈 Monitoring ${this.activePositions.size} active positions`);

    for (const [contractId, positions] of this.activePositions.entries()) {
      for (const position of positions) {
        try {
          const platform = this.bettingPlatforms.find((p) => p.name === position.platform);
          if (!platform) {
            continue;
          }

          const contract = await platform.getContract(contractId);
          if (!contract) {
            continue;
          }

          const currentPrice = position.side === 'yes' ? contract.yesPrice : contract.noPrice;
          const pnl = (currentPrice - position.averagePrice) * position.quantity;
          const pnlPercent = ((currentPrice - position.averagePrice) / position.averagePrice) * 100;

          console.log(
            `    Position: ${position.quantity} ${position.side} @ ${position.averagePrice} | Current: ${currentPrice} | P&L: $${pnl.toFixed(
              2,
            )} (${pnlPercent.toFixed(1)}%)`,
          );
        } catch (error) {
          console.error(`Failed to monitor position ${contractId}:`, error);
        }
      }
    }
  }

  async testContract(platformName: string, marketId: string): Promise<Contract[]> {
    try {
      const platform = this.bettingPlatforms.find((p) => p.name === platformName);
      if (!platform) {
        return [];
      }

      // Get all available contracts and filter by market-like ID
      const allContracts = await platform.getAvailableContracts();
      const contracts = allContracts.filter((c) => c.id.includes(marketId));
      return contracts;
    } catch (error) {
      console.error('Test contract failed:', error);
      return [];
    }
  }
}
