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

export interface OrchestratorConfig {
  pollIntervalMs: number;
  minRelevanceScore: number;
  minConfidenceScore: number;
  maxPositionsPerContract: number;
  dryRun: boolean;
}

export interface ProcessingResult {
  newsProcessed: number;
  insightsGenerated: number;
  marketsSearched: number;
  contractsValidated: number;
  positionsCreated: number;
  errors: string[];
}

export class OrchestratorService {
  private newsServices: NewsService[] = [];
  private bettingPlatforms: BettingPlatform[] = [];
  private llmProviders: LLMProvider[] = [];
  private newsParser: NewsParserService;
  private contractValidator: ContractValidatorService;
  private config: OrchestratorConfig;
  private isRunning = false;
  private pollInterval?: NodeJS.Timeout;

  constructor(config: OrchestratorConfig) {
    this.config = config;
    this.newsParser = new NewsParserService();
    this.contractValidator = new ContractValidatorService();
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

        const validatedContracts = await this.findAndValidateContracts(insight);
        result.contractsValidated += validatedContracts.length;

        for (const validation of validatedContracts) {
          if (
            validation.suggestedConfidence >= this.config.minConfidenceScore &&
            validation.suggestedPosition !== 'hold'
          ) {
            if (this.config.dryRun) {
              console.log(
                `[DRY RUN] Would place ${validation.suggestedPosition} order for contract ${validation.contractId}`,
              );
              result.positionsCreated++;
            } else {
              const position = await this.placeOrder(validation);
              if (position) {
                result.positionsCreated++;
                console.log(`Created position: ${position.id}`);
              }
            }
          }
        }
        result.marketsSearched++;
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
        allNews.push(...news);
      } catch (error) {
        console.error(`Error fetching news from ${service.name}:`, error);
      }
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

  private async findAndValidateContracts(
    insight: ParsedNewsInsight,
  ): Promise<ContractValidation[]> {
    const validations: ContractValidation[] = [];

    if (this.llmProviders.length === 0 || this.bettingPlatforms.length === 0) {
      return validations;
    }

    const llmProvider = this.llmProviders[0];

    for (const action of insight.suggestedActions) {
      if (action.type !== 'bet' || !action.relatedMarketQuery) {
        continue;
      }

      for (const platform of this.bettingPlatforms) {
        try {
          const markets = await platform.searchMarkets(action.relatedMarketQuery);

          for (const market of markets.slice(0, 3)) {
            const contracts = await platform.getContracts(market.id);
            const contractValidations = await this.contractValidator.batchValidateContracts(
              contracts,
              insight,
              llmProvider,
            );
            validations.push(...contractValidations);
          }
        } catch (error) {
          console.error(`Error searching markets on ${platform.name}:`, error);
        }
      }
    }

    return validations
      .filter((v) => v.isRelevant)
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, 5);
  }

  private async placeOrder(validation: ContractValidation): Promise<Position | null> {
    if (!validation.suggestedPosition || validation.suggestedPosition === 'hold') {
      return null;
    }

    for (const platform of this.bettingPlatforms) {
      try {
        const contract = await platform.getContract(validation.contractId);

        const quantity = this.calculateOrderQuantity(validation, contract);
        const position = await platform.placeOrder(
          contract.id,
          validation.suggestedPosition,
          quantity,
          contract.currentPrice,
        );

        console.log(
          `Placed ${validation.suggestedPosition} order: ${quantity} contracts at ${contract.currentPrice}`,
        );
        return position;
      } catch (error) {
        console.error(`Error placing order on ${platform.name}:`, error);
      }
    }

    return null;
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
  }> {
    return {
      isRunning: this.isRunning,
      services: {
        news: this.newsServices.length,
        betting: this.bettingPlatforms.length,
        llm: this.llmProviders.length,
      },
      config: this.config,
    };
  }
}
