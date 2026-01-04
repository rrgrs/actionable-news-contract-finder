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
import { PersistenceService } from '../persistence/PersistenceService';
import { createLogger, logArticleProcessing, logContractValidation } from '../../utils/logger';

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
  private persistenceService: PersistenceService;
  private activePositions: Map<string, Position[]> = new Map();
  private logger = createLogger('Orchestrator');

  constructor(
    private config: OrchestratorConfig,
    private newsServices: NewsService[],
    private bettingPlatforms: BettingPlatform[],
    private llmProviders: LLMProvider[],
    alertConfig?: AlertConfig,
    persistenceDbPath?: string,
  ) {
    this.newsParser = new NewsParserService();
    this.contractValidator = new ContractValidatorService();
    this.persistenceService = new PersistenceService(persistenceDbPath);

    if (alertConfig) {
      this.alertService = new AlertService(alertConfig);
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.info('OrchestratorService is already running');
      return;
    }

    // Initialize persistence service
    await this.persistenceService.initialize();

    // Display stats from previous runs
    const stats = await this.persistenceService.getRecentStats(24);
    this.logger.info('Service initialization complete', {
      last24HoursStats: {
        newsProcessed: stats.newsProcessed,
      },
    });

    this.isRunning = true;
    this.logger.info('OrchestratorService started', {
      mode: this.config.dryRun ? 'DRY RUN' : 'LIVE',
      betPlacement: this.config.placeBets ? 'ENABLED' : 'DISABLED',
      pollIntervalSeconds: this.config.pollIntervalMs / 1000,
      newsServices: this.newsServices.map((s) => s.name),
      bettingPlatforms: this.bettingPlatforms.map((p) => p.name),
      llmProviders: this.llmProviders.map((p) => p.name),
      alerts: this.alertService ? 'ENABLED' : 'DISABLED',
      persistence: 'ENABLED (SQLite)',
    });

    // Process immediately
    await this.processLoop();

    // Then set up recurring interval
    this.processInterval = setInterval(() => {
      this.processLoop().catch((error) => {
        this.logger.error('Error in processing loop', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.config.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      this.logger.info('OrchestratorService is not running');
      return;
    }

    this.isRunning = false;
    if (this.processInterval) {
      clearInterval(this.processInterval);
      this.processInterval = null;
    }

    // Close database connection
    await this.persistenceService.close();

    this.logger.info('OrchestratorService stopped');
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
      this.logger.info('Starting news processing cycle', {
        timestamp: new Date().toISOString(),
      });

      // Step 1: Fetch news from all sources
      const allNews = await this.fetchAllNews();
      result.newsProcessed = allNews.length;

      if (allNews.length === 0) {
        this.logger.info('No new news items found');
        return result;
      }

      this.logger.info('News fetching complete', {
        newsItemsFound: allNews.length,
      });

      // Step 2: Parse news for insights
      const insights = await this.parseNewsForInsights(allNews);
      result.insightsGenerated = insights.length;

      if (insights.length === 0) {
        this.logger.info('No actionable insights generated');
        return result;
      }

      this.logger.info('Insight generation complete', {
        actionableInsights: insights.length,
      });

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
                .filter((contract) =>
                  contract.title.toLowerCase().includes(action.relatedMarketQuery!.toLowerCase()),
                )
                .slice(0, 10); // Limit to 10 contracts

              result.marketsSearched += relevantContracts.length;

              if (relevantContracts.length > 0) {
                const contractsToValidate = relevantContracts;

                const contractValidations = await this.contractValidator.batchValidateContracts(
                  contractsToValidate,
                  insight,
                  this.llmProviders[0],
                );
                result.contractsValidated += contractValidations.length;

                // Process validation results
                for (const validation of contractValidations) {
                  // Log the validation result using helper function
                  logContractValidation(
                    this.logger,
                    validation.contractId,
                    platform.name,
                    insight.originalNewsId,
                    validation.isRelevant,
                    validation.suggestedPosition,
                    validation.suggestedConfidence,
                  );
                }

                // Process validated contracts
                for (const validation of contractValidations) {
                  if (
                    validation.isRelevant &&
                    validation.suggestedConfidence >= this.config.minConfidenceScore &&
                    validation.suggestedPosition !== 'hold'
                  ) {
                    const contract = contractsToValidate.find(
                      (c) => c.id === validation.contractId,
                    );
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
                        this.logger.info('Alert sent successfully', {
                          marketTitle: contract.title,
                          suggestedPosition: validation.suggestedPosition,
                          confidence: validation.suggestedConfidence,
                        });
                      } catch (error) {
                        this.logger.error('Failed to send alert', {
                          error: error instanceof Error ? error.message : String(error),
                          marketTitle: contract.title,
                        });
                        result.errors.push(`Alert failed: ${error}`);
                      }
                    }

                    // Handle bet placement
                    const quantity = this.calculateOrderQuantity(validation, contract);
                    const currentPrice =
                      validation.suggestedPosition === 'buy' ? contract.yesPrice : contract.noPrice;

                    if (!this.config.placeBets) {
                      this.logger.info('Trading opportunity found (bets disabled)', {
                        action: validation.suggestedPosition,
                        quantity,
                        contractTitle: contract.title,
                        currentPrice,
                        confidence: Math.round(validation.suggestedConfidence * 100),
                        reasoning: validation.reasoning,
                      });
                      result.positionsCreated++; // Count as found opportunity
                    } else if (this.config.dryRun) {
                      this.logger.info('Dry run - would place order', {
                        action: validation.suggestedPosition,
                        quantity,
                        currentPrice,
                        contractTitle: contract.title,
                      });
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

                        this.logger.info('Order placed successfully', {
                          action: validation.suggestedPosition,
                          quantity,
                          orderId: orderStatus.orderId,
                          contractTitle: contract.title,
                          platform: platform.name,
                        });
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
                        this.logger.error('Failed to place order', {
                          error: error instanceof Error ? error.message : String(error),
                          contractTitle: contract.title,
                          platform: platform.name,
                          action: validation.suggestedPosition,
                        });
                        result.errors.push(`Order placement failed: ${error}`);
                      }
                    }
                  }
                }
              }
            } catch (error) {
              this.logger.error('Failed to search markets', {
                platform: platform.name,
                error: error instanceof Error ? error.message : String(error),
              });
              result.errors.push(`Market search failed on ${platform.name}: ${error}`);
            }
          }
        }
      }

      // Step 4: Monitor existing positions (if any)
      await this.monitorPositions();

      this.logger.info('Processing cycle complete', {
        newsProcessed: result.newsProcessed,
        insightsGenerated: result.insightsGenerated,
        marketsSearched: result.marketsSearched,
        contractsValidated: result.contractsValidated,
        positionsCreated: result.positionsCreated,
        alertsSent: result.alertsSent,
        errorsCount: result.errors.length,
      });

      if (result.errors.length > 0) {
        this.logger.warn('Errors encountered during processing', {
          errorCount: result.errors.length,
          errors: result.errors,
        });
      }
    } catch (error) {
      this.logger.error('Error in processing loop', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      result.errors.push(`Processing loop error: ${error}`);
    }

    return result;
  }

  private async fetchAllNews(): Promise<NewsItem[]> {
    const allNews: NewsItem[] = [];

    // Get already processed news IDs to avoid reprocessing
    const processedNewsIds = await this.persistenceService.getProcessedNewsIds();
    let skippedCount = 0;

    for (const service of this.newsServices) {
      try {
        const news = await service.fetchLatestNews();

        // Filter out already processed news
        const newNews = news.filter((item) => {
          if (processedNewsIds.has(item.id)) {
            skippedCount++;
            return false;
          }
          return true;
        });

        allNews.push(...newNews);
      } catch (error) {
        this.logger.error('Failed to fetch news from service', {
          serviceName: service.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (skippedCount > 0) {
      this.logger.debug('Skipped already processed news items', {
        skippedCount,
      });
    }

    // Deduplicate by title similarity within this batch
    const seen = new Set<string>();
    const deduplicatedNews = allNews.filter((item) => {
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

    // Mark all fetched news as processed with their text
    for (const item of deduplicatedNews) {
      await this.persistenceService.markNewsAsProcessed(item.id, {
        title: item.title,
        content: item.content?.substring(0, 5000), // Limit content size
      });
    }

    return deduplicatedNews;
  }

  private async parseNewsForInsights(newsItems: NewsItem[]): Promise<ParsedNewsInsight[]> {
    if (!this.llmProviders[0]) {
      this.logger.error('No LLM provider available');
      return [];
    }

    try {
      // Use batch processing to reduce API calls
      this.logger.debug('Starting batch processing for news items', {
        newsItemCount: newsItems.length,
      });
      const allInsights = await this.newsParser.batchParseNews(newsItems, this.llmProviders[0]);

      // Filter for actionable insights only
      const actionableInsights = allInsights.filter((insight) =>
        insight.suggestedActions.some(
          (a) => a.type === 'bet' && a.confidence >= this.config.minRelevanceScore,
        ),
      );

      this.logger.info('Batch processing complete', {
        actionableInsights: actionableInsights.length,
        totalInsights: allInsights.length,
      });

      // Log each actionable insight
      for (const insight of actionableInsights) {
        const newsItem = newsItems.find((n) => n.id === insight.originalNewsId);
        if (newsItem) {
          logArticleProcessing(
            this.logger,
            newsItem,
            true, // actionable
            `Generated ${insight.suggestedActions.length} trading actions`,
            insight.relevanceScore,
          );
        }
      }

      return actionableInsights;
    } catch (error) {
      this.logger.warn('Batch processing failed, falling back to individual processing', {
        error: error instanceof Error ? error.message : String(error),
      });

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
            logArticleProcessing(
              this.logger,
              news,
              true, // actionable
              `Generated ${insight.suggestedActions.length} trading actions`,
              insight.relevanceScore,
            );
          } else {
            logArticleProcessing(
              this.logger,
              news,
              false, // not actionable
              'No actionable trading suggestions above threshold',
            );
          }
        } catch (error) {
          this.logger.error('Failed to parse news item', {
            newsTitle: news.title,
            newsId: news.id,
            error: error instanceof Error ? error.message : String(error),
          });
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

    this.logger.debug('Monitoring active positions', {
      activePositionsCount: this.activePositions.size,
    });

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

          this.logger.debug('Position update', {
            contractId,
            quantity: position.quantity,
            side: position.side,
            averagePrice: position.averagePrice,
            currentPrice,
            pnl: parseFloat(pnl.toFixed(2)),
            pnlPercent: parseFloat(pnlPercent.toFixed(1)),
          });
        } catch (error) {
          this.logger.error('Failed to monitor position', {
            contractId,
            error: error instanceof Error ? error.message : String(error),
          });
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
      this.logger.error('Test contract failed', {
        platformName,
        marketId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }
}
