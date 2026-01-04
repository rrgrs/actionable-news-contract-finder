import { PrismaClient } from '@prisma/client';
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
  MatchedMarket,
} from '../../types';
import { ContractMatch } from '../persistence/PersistenceService';
import { NewsParserService } from '../analysis/NewsParserService';
import { ContractValidatorService } from '../analysis/ContractValidatorService';
import { AlertService, AlertPayload } from '../alerts/AlertService';
import { AlertConfig } from '../../config/types';
import { PersistenceService } from '../persistence/PersistenceService';
import { MarketSyncService, MarketSyncConfig } from '../betting/MarketSyncService';
import { MarketMatchingService, MarketMatchConfig } from '../betting/MarketMatchingService';
import { EmbeddingService, EmbeddingConfig } from '../embedding/EmbeddingService';
import { createLogger, logArticleProcessing, logContractValidation } from '../../utils/logger';

export interface OrchestratorV2Config {
  pollIntervalMs: number;
  minRelevanceScore: number;
  minConfidenceScore: number;
  maxPositionsPerContract: number;
  dryRun: boolean;
  placeBets: boolean;
  // Config options for market sync
  marketSyncIntervalMs: number;
  embeddingBatchSize: number;
  topMatchingMarkets: number;
  minSimilarityScore?: number;
}

export interface ProcessingResult {
  newsProcessed: number;
  insightsGenerated: number;
  marketsMatched: number;
  contractsValidated: number;
  contractMatchesSaved: number;
  positionsCreated: number;
  alertsSent: number;
  errors: string[];
}

/**
 * OrchestratorServiceV2 - Uses embedding-based market matching instead of on-demand search.
 *
 * Architecture:
 * 1. MarketSyncService runs on a separate interval to keep markets database up-to-date
 * 2. When news arrives, we use embeddings to find similar markets
 * 3. LLM validates matched contracts against news insights
 * 4. High-confidence matches trigger alerts/trades
 */
export class OrchestratorServiceV2 {
  private isRunning = false;
  private processInterval: NodeJS.Timeout | null = null;
  private newsParser: NewsParserService;
  private contractValidator: ContractValidatorService;
  private alertService?: AlertService;
  private persistenceService: PersistenceService;
  private marketSyncService!: MarketSyncService;
  private marketMatchingService!: MarketMatchingService;
  private embeddingService!: EmbeddingService;
  private activePositions: Map<string, Position[]> = new Map();
  private logger = createLogger('OrchestratorV2');
  private prisma!: PrismaClient;

  constructor(
    private config: OrchestratorV2Config,
    private newsServices: NewsService[],
    private bettingPlatforms: BettingPlatform[],
    private llmProviders: LLMProvider[],
    private embeddingConfig: EmbeddingConfig,
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
      this.logger.info('OrchestratorServiceV2 is already running');
      return;
    }

    // Initialize persistence service and get Prisma client
    await this.persistenceService.initialize();
    this.prisma = this.persistenceService.getPrismaClient();

    // Initialize embedding service
    this.embeddingService = new EmbeddingService(this.embeddingConfig);

    // Initialize market sync service
    const marketSyncConfig: MarketSyncConfig = {
      syncIntervalMs: this.config.marketSyncIntervalMs,
      embeddingBatchSize: this.config.embeddingBatchSize,
    };
    this.marketSyncService = new MarketSyncService(
      this.prisma,
      this.bettingPlatforms,
      this.embeddingService,
      marketSyncConfig,
    );
    await this.marketSyncService.initialize();

    // Initialize market matching service
    const marketMatchConfig: MarketMatchConfig = {
      topN: this.config.topMatchingMarkets,
      minSimilarity: this.config.minSimilarityScore,
    };
    this.marketMatchingService = new MarketMatchingService(
      this.prisma,
      this.embeddingService,
      marketMatchConfig,
    );
    await this.marketMatchingService.initialize();

    // Display stats from previous runs
    const stats = await this.persistenceService.getRecentStats(24);
    const syncStats = await this.marketSyncService.getSyncStats();

    this.logger.info('Service initialization complete', {
      last24HoursStats: {
        newsProcessed: stats.newsProcessed,
        contractsMatched: stats.contractsMatched,
      },
      marketDatabase: {
        totalActiveMarkets: syncStats.totalActiveMarkets,
        totalActiveContracts: syncStats.totalActiveContracts,
        marketsWithEmbeddings: syncStats.marketsWithEmbeddings,
        marketsByPlatform: syncStats.marketsByPlatform,
      },
    });

    this.isRunning = true;

    // Start market sync service (runs on its own interval)
    await this.marketSyncService.start();

    this.logger.info('OrchestratorServiceV2 started', {
      mode: this.config.dryRun ? 'DRY RUN' : 'LIVE',
      betPlacement: this.config.placeBets ? 'ENABLED' : 'DISABLED',
      pollIntervalSeconds: this.config.pollIntervalMs / 1000,
      marketSyncIntervalMinutes: this.config.marketSyncIntervalMs / 60000,
      topMatchingMarkets: this.config.topMatchingMarkets,
      newsServices: this.newsServices.map((s) => s.name),
      bettingPlatforms: this.bettingPlatforms.map((p) => p.name),
      llmProviders: this.llmProviders.map((p) => p.name),
      alerts: this.alertService ? 'ENABLED' : 'DISABLED',
      persistence: 'ENABLED (SQLite)',
      architecture: 'V3 - Market-based embedding matching',
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
      this.logger.info('OrchestratorServiceV2 is not running');
      return;
    }

    this.isRunning = false;
    if (this.processInterval) {
      clearInterval(this.processInterval);
      this.processInterval = null;
    }

    // Stop market sync service
    await this.marketSyncService.stop();

    // Close database connection
    await this.persistenceService.close();

    this.logger.info('OrchestratorServiceV2 stopped');
  }

  private async processLoop(): Promise<ProcessingResult> {
    const result: ProcessingResult = {
      newsProcessed: 0,
      insightsGenerated: 0,
      marketsMatched: 0,
      contractsValidated: 0,
      contractMatchesSaved: 0,
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

      // Step 2: Find matching markets for each news item using embeddings
      const newsToMatches = await this.marketMatchingService.findMatchingMarketsForBatch(allNews);

      // Count total matches
      for (const matches of newsToMatches.values()) {
        result.marketsMatched += matches.length;
      }

      this.logger.info('Market matching complete', {
        newsItemsWithMatches: Array.from(newsToMatches.values()).filter((m) => m.length > 0).length,
        totalMarketsMatched: result.marketsMatched,
      });

      // Mark all news items as processed (title/content only, contract matches saved after LLM validation)
      for (const newsItem of allNews) {
        await this.persistenceService.markNewsAsProcessed(newsItem.id, {
          title: newsItem.title,
          content: newsItem.content?.substring(0, 5000), // Limit content size
        });
      }

      // Step 3: Parse news for insights (for validation context)
      const insights = await this.parseNewsForInsights(allNews);
      result.insightsGenerated = insights.length;

      if (insights.length === 0) {
        this.logger.info('No actionable insights generated');
        return result;
      }

      this.logger.info('Insight generation complete', {
        actionableInsights: insights.length,
      });

      // Step 4: Validate matched markets' contracts against insights
      for (const insight of insights) {
        const newsItem = allNews.find((n) => n.id === insight.originalNewsId);
        if (!newsItem) {
          continue;
        }

        const matchedMarkets = newsToMatches.get(newsItem.id) || [];
        if (matchedMarkets.length === 0) {
          this.logger.debug('No matched markets for news item', {
            newsId: newsItem.id,
            newsTitle: newsItem.title.substring(0, 50),
          });
          continue;
        }

        // Collect all contracts from matched markets for validation
        const contractsToValidate: Contract[] = [];
        const contractToMarketMap = new Map<string, MatchedMarket>();

        for (const matchedMarket of matchedMarkets) {
          for (const contractOutcome of matchedMarket.contracts) {
            // Convert ContractOutcome to Contract for validation
            const contract: Contract = {
              id: contractOutcome.contractTicker,
              platform: contractOutcome.platform,
              title: contractOutcome.title,
              yesPrice: contractOutcome.yesPrice,
              noPrice: contractOutcome.noPrice,
              volume: contractOutcome.volume,
              liquidity: contractOutcome.liquidity,
              endDate: matchedMarket.market.endDate || new Date(),
              tags: matchedMarket.market.category ? [matchedMarket.market.category] : [],
              url: matchedMarket.market.url,
              metadata: {
                ...contractOutcome.metadata,
                marketTitle: matchedMarket.market.title,
                similarity: matchedMarket.similarity,
              },
            };
            contractsToValidate.push(contract);
            contractToMarketMap.set(contract.id, matchedMarket);
          }
        }

        if (contractsToValidate.length === 0) {
          this.logger.debug('No contracts to validate for this news', {
            newsId: insight.originalNewsId,
          });
          continue;
        }

        this.logger.debug('Validating matched contracts', {
          newsId: insight.originalNewsId,
          matchedMarkets: matchedMarkets.length,
          toValidate: contractsToValidate.length,
          topSimilarity: matchedMarkets[0]?.similarity.toFixed(4),
        });

        // Validate contracts with enhanced context including similarity scores
        const contractValidations = await this.contractValidator.batchValidateContracts(
          contractsToValidate,
          insight,
          this.llmProviders[0],
        );
        result.contractsValidated += contractValidations.length;

        // Collect LLM-validated contract matches for persistence
        const contractMatches: ContractMatch[] = [];

        // Process validation results
        for (const validation of contractValidations) {
          const contract = contractsToValidate.find((c) => c.id === validation.contractId);
          if (!contract) {
            continue;
          }

          logContractValidation(
            this.logger,
            validation.contractId,
            contract.platform,
            insight.originalNewsId,
            validation.isRelevant,
            validation.suggestedPosition,
            validation.suggestedConfidence,
          );

          // Save all relevant contracts to persistence (not just high-confidence ones)
          if (validation.isRelevant && validation.relevanceScore > 0) {
            const matchedMarket = contractToMarketMap.get(contract.id);
            contractMatches.push({
              contractTicker: contract.id, // contract.id is the contractTicker
              similarity: matchedMarket?.similarity,
              relevanceScore: validation.relevanceScore,
              confidence: validation.suggestedConfidence,
              suggestedPosition: validation.suggestedPosition || 'hold',
              reasoning: validation.reasoning,
            });
          }

          // Process high-confidence validated contracts for alerts/trading
          if (
            validation.isRelevant &&
            validation.suggestedConfidence >= this.config.minConfidenceScore &&
            validation.suggestedPosition !== 'hold'
          ) {
            // Get the matched market for this contract
            const matchedMarket = contractToMarketMap.get(contract.id);

            // Send alert if configured
            if (this.alertService) {
              const alertPayload: AlertPayload = {
                newsTitle: newsItem.title,
                newsUrl: newsItem.url,
                marketTitle: matchedMarket?.market.title || contract.title,
                marketUrl: matchedMarket?.market.url || contract.url || '',
                contractTitle: contract.title,
                suggestedPosition: (validation.suggestedPosition || 'buy') as 'buy' | 'sell',
                confidence: validation.suggestedConfidence,
                currentPrice:
                  validation.suggestedPosition === 'buy' ? contract.yesPrice : contract.noPrice,
                reasoning: `${validation.reasoning} (Semantic similarity: ${((matchedMarket?.similarity || 0) * 100).toFixed(1)}%)`,
                timestamp: new Date(),
              };

              try {
                await this.alertService.sendAlert(alertPayload);
                result.alertsSent++;
                this.logger.info('Alert sent successfully', {
                  marketTitle: matchedMarket?.market.title,
                  contractTitle: contract.title,
                  suggestedPosition: validation.suggestedPosition,
                  confidence: validation.suggestedConfidence,
                  similarity: matchedMarket?.similarity,
                });
              } catch (error) {
                this.logger.error('Failed to send alert', {
                  error: error instanceof Error ? error.message : String(error),
                  contractTitle: contract.title,
                });
                result.errors.push(`Alert failed: ${error}`);
              }
            }

            // Handle bet placement
            await this.handleBetPlacement(validation, contract, result);
          }
        }

        // Save LLM-validated contract matches to persistence
        if (contractMatches.length > 0) {
          try {
            const savedCount = await this.persistenceService.saveContractMatches(
              insight.originalNewsId,
              contractMatches,
            );
            result.contractMatchesSaved += savedCount;
            this.logger.debug('Saved contract matches to persistence', {
              newsId: insight.originalNewsId,
              matchCount: savedCount,
            });
          } catch (error) {
            this.logger.error('Failed to save contract matches', {
              newsId: insight.originalNewsId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      // Step 5: Monitor existing positions
      await this.monitorPositions();

      this.logger.info('Processing cycle complete', {
        newsProcessed: result.newsProcessed,
        insightsGenerated: result.insightsGenerated,
        marketsMatched: result.marketsMatched,
        contractsValidated: result.contractsValidated,
        contractMatchesSaved: result.contractMatchesSaved,
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

  private async handleBetPlacement(
    validation: ContractValidation,
    contract: Contract,
    result: ProcessingResult,
  ): Promise<void> {
    const platform = this.bettingPlatforms.find((p) => p.name === contract.platform);
    if (!platform) {
      this.logger.warn('Platform not found for contract', {
        contractId: contract.id,
        platform: contract.platform,
      });
      return;
    }

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
      result.positionsCreated++;
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

        if (orderStatus) {
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

  private async fetchAllNews(): Promise<NewsItem[]> {
    const allNews: NewsItem[] = [];
    const processedNewsIds = await this.persistenceService.getProcessedNewsIds();
    let skippedCount = 0;

    for (const service of this.newsServices) {
      try {
        const news = await service.fetchLatestNews();
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
      this.logger.debug('Skipped already processed news items', { skippedCount });
    }

    // Deduplicate by title similarity
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

    // Note: News is marked as processed after market matching in processNewsCycle()
    // so we can log matched market IDs alongside the news

    return deduplicatedNews;
  }

  private async parseNewsForInsights(newsItems: NewsItem[]): Promise<ParsedNewsInsight[]> {
    if (!this.llmProviders[0]) {
      this.logger.error('No LLM provider available');
      return [];
    }

    try {
      this.logger.debug('Starting batch processing for news items', {
        newsItemCount: newsItems.length,
      });
      const allInsights = await this.newsParser.batchParseNews(newsItems, this.llmProviders[0]);

      // For V3, we still want insights for validation context,
      // but we don't filter based on suggested actions since we use embedding matching
      const relevantInsights = allInsights.filter(
        (insight) => insight.relevanceScore >= this.config.minRelevanceScore,
      );

      this.logger.info('Batch processing complete', {
        relevantInsights: relevantInsights.length,
        totalInsights: allInsights.length,
      });

      // Log insights for monitoring
      for (const insight of relevantInsights) {
        const newsItem = newsItems.find((n) => n.id === insight.originalNewsId);
        if (newsItem) {
          logArticleProcessing(
            this.logger,
            newsItem,
            true,
            `Relevance score: ${insight.relevanceScore.toFixed(2)}`,
            insight.relevanceScore,
          );
        }
      }

      return relevantInsights;
    } catch (error) {
      this.logger.warn('Batch processing failed, falling back to individual processing', {
        error: error instanceof Error ? error.message : String(error),
      });

      const insights: ParsedNewsInsight[] = [];
      for (const news of newsItems) {
        try {
          const insight = await this.newsParser.parseNews(news, this.llmProviders[0]);
          if (insight.relevanceScore >= this.config.minRelevanceScore) {
            insights.push(insight);
            logArticleProcessing(
              this.logger,
              news,
              true,
              `Relevance score: ${insight.relevanceScore.toFixed(2)}`,
              insight.relevanceScore,
            );
          } else {
            logArticleProcessing(this.logger, news, false, 'Below relevance threshold');
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
    const baseQuantity = 10;
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

  /**
   * Force a market sync
   */
  async forceMarketSync(): Promise<void> {
    await this.marketSyncService.syncAllPlatforms();
  }

  /**
   * Get market sync statistics
   */
  async getMarketSyncStats(): Promise<{
    totalActiveMarkets: number;
    totalActiveContracts: number;
    marketsWithEmbeddings: number;
    marketsByPlatform: Record<string, number>;
    oldestSync: Date | null;
    newestSync: Date | null;
  }> {
    return this.marketSyncService.getSyncStats();
  }

  /**
   * Get matching service statistics
   */
  async getMatchingStats(): Promise<{
    totalActiveMarkets: number;
    totalActiveContracts: number;
    marketsWithEmbeddings: number;
  }> {
    return this.marketMatchingService.getStats();
  }
}
