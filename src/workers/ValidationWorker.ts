import { NewsStatus, NewsArticle, NewsMarketMatch, Market } from '@prisma/client';
import { LLMProvider, Contract } from '../types';
import { ContractValidatorService } from '../services/analysis/ContractValidatorService';
import { NewsParserService } from '../services/analysis/NewsParserService';
import { AlertService, AlertPayload } from '../services/alerts/AlertService';
import { AlertConfig } from '../config/types';
import { BaseWorker, WorkerConfig } from './BaseWorker';

export interface ValidationWorkerConfig extends WorkerConfig {
  /** LLM provider for validation */
  llmProvider: LLMProvider;
  /** Minimum confidence score to send alerts */
  minConfidence?: number;
  /** Alert configuration (optional) */
  alertConfig?: AlertConfig;
}

type MatchWithMarket = NewsMarketMatch & {
  market: Market & {
    contracts: {
      id: number;
      contractTicker: string;
      title: string;
      yesPrice: number;
      noPrice: number;
    }[];
  };
};

/**
 * Worker that validates news-market matches using LLM.
 * Sends alerts for high-confidence matches.
 * Transitions articles from MATCHED -> VALIDATED status.
 */
export class ValidationWorker extends BaseWorker {
  private llmProvider: LLMProvider;
  private contractValidator: ContractValidatorService;
  private newsParser: NewsParserService;
  private alertService?: AlertService;
  private minConfidence: number;

  constructor(config: ValidationWorkerConfig) {
    super({
      ...config,
      name: config.name || 'ValidationWorker',
      batchSize: config.batchSize || 3, // Small batches for LLM calls
      idleDelayMs: config.idleDelayMs || 2000, // Longer idle delay to respect rate limits
    });
    this.llmProvider = config.llmProvider;
    this.contractValidator = new ContractValidatorService();
    this.newsParser = new NewsParserService();
    this.minConfidence = config.minConfidence || 0.7;

    if (config.alertConfig) {
      this.alertService = new AlertService(config.alertConfig);
    }
  }

  protected async processBatch(): Promise<number> {
    // Fetch MATCHED articles with unvalidated matches
    const articles = await this.prisma.newsArticle.findMany({
      where: {
        status: NewsStatus.MATCHED,
        marketMatches: {
          some: { isValidated: false },
        },
      },
      include: {
        marketMatches: {
          where: { isValidated: false },
          include: {
            market: {
              include: {
                contracts: {
                  where: { isActive: true },
                  select: {
                    id: true,
                    contractTicker: true,
                    title: true,
                    yesPrice: true,
                    noPrice: true,
                  },
                },
              },
            },
          },
          orderBy: { similarity: 'desc' },
          take: 10, // Limit matches to validate per article
        },
      },
      take: this.batchSize,
      orderBy: { matchedAt: 'asc' },
    });

    if (articles.length === 0) {
      return 0;
    }

    this.logger.debug('Processing articles for validation', {
      count: articles.length,
    });

    let successCount = 0;

    for (const article of articles) {
      try {
        await this.validateArticleMatches(article, article.marketMatches as MatchWithMarket[]);
        successCount++;
      } catch (error) {
        this.logger.error('Failed to validate article matches', {
          articleId: article.id,
          error: error instanceof Error ? error.message : String(error),
        });

        // Don't fail the article, just mark matches as validated with error
        await this.prisma.newsMarketMatch.updateMany({
          where: {
            newsArticleId: article.id,
            isValidated: false,
          },
          data: {
            isValidated: true,
            isRelevant: false,
            reasoning: `Validation error: ${error instanceof Error ? error.message : String(error)}`,
            validatedAt: new Date(),
          },
        });
      }

      // Check if article has any unvalidated matches left
      const remainingMatches = await this.prisma.newsMarketMatch.count({
        where: {
          newsArticleId: article.id,
          isValidated: false,
        },
      });

      if (remainingMatches === 0) {
        await this.prisma.newsArticle.update({
          where: { id: article.id },
          data: {
            status: NewsStatus.VALIDATED,
            validatedAt: new Date(),
          },
        });
      }
    }

    return successCount;
  }

  /**
   * Validate matches for a single article using LLM.
   */
  private async validateArticleMatches(
    article: NewsArticle,
    matches: MatchWithMarket[],
  ): Promise<void> {
    if (matches.length === 0) {
      return;
    }

    // Parse the news article for context
    const insight = await this.newsParser.parseNews(
      {
        id: article.externalId,
        source: article.source,
        title: article.title,
        content: article.content || '',
        url: article.url || '',
        publishedAt: article.publishedAt,
        tags: article.tags,
      },
      this.llmProvider,
    );

    // Build contracts list for validation
    const contractsToValidate: Contract[] = [];
    const contractToMatchMap = new Map<string, MatchWithMarket>();

    for (const match of matches) {
      // For each market, pick the most relevant contract (usually just one)
      const contract = match.market.contracts[0];
      if (contract) {
        const contractData: Contract = {
          id: contract.contractTicker,
          platform: match.market.platform,
          title: `${match.market.title} - ${contract.title}`,
          yesPrice: contract.yesPrice,
          noPrice: contract.noPrice,
          volume: 0,
          liquidity: 0,
          endDate: match.market.endDate || new Date(),
          tags: match.market.category ? [match.market.category] : [],
          url: match.market.url,
          metadata: { similarity: match.similarity },
        };
        contractsToValidate.push(contractData);
        contractToMatchMap.set(contract.contractTicker, match);
      }
    }

    if (contractsToValidate.length === 0) {
      return;
    }

    // Validate with LLM
    const validations = await this.contractValidator.batchValidateContracts(
      contractsToValidate,
      insight,
      this.llmProvider,
    );

    // Update match records with validation results
    for (const validation of validations) {
      const match = contractToMatchMap.get(validation.contractId);
      if (!match) {
        continue;
      }

      await this.prisma.newsMarketMatch.update({
        where: { id: match.id },
        data: {
          isValidated: true,
          isRelevant: validation.isRelevant,
          relevanceScore: validation.relevanceScore,
          confidence: validation.suggestedConfidence,
          suggestedPosition: validation.suggestedPosition || 'hold',
          reasoning: validation.reasoning,
          validatedAt: new Date(),
        },
      });

      // Send alert for high-confidence relevant matches
      if (
        this.alertService &&
        validation.isRelevant &&
        validation.suggestedConfidence >= this.minConfidence &&
        validation.suggestedPosition !== 'hold'
      ) {
        await this.sendAlert(article, match, validation);
      }
    }

    this.logger.info('Validated matches for article', {
      articleId: article.id,
      title: article.title.substring(0, 50),
      matchesValidated: validations.length,
      relevant: validations.filter((v) => v.isRelevant).length,
      highConfidence: validations.filter((v) => v.suggestedConfidence >= this.minConfidence).length,
    });
  }

  /**
   * Send an alert for a high-confidence match.
   */
  private async sendAlert(
    article: NewsArticle,
    match: MatchWithMarket,
    validation: { suggestedPosition?: string; suggestedConfidence: number; reasoning: string },
  ): Promise<void> {
    if (!this.alertService) {
      return;
    }

    const contract = match.market.contracts[0];
    if (!contract) {
      return;
    }

    const alertPayload: AlertPayload = {
      newsTitle: article.title,
      newsUrl: article.url || '',
      marketTitle: match.market.title,
      marketUrl: match.market.url,
      contractTitle: contract.title,
      suggestedPosition: (validation.suggestedPosition || 'buy') as 'buy' | 'sell',
      confidence: validation.suggestedConfidence,
      currentPrice: validation.suggestedPosition === 'buy' ? contract.yesPrice : contract.noPrice,
      reasoning: `${validation.reasoning} (Similarity: ${(match.similarity * 100).toFixed(1)}%)`,
      timestamp: new Date(),
    };

    try {
      await this.alertService.sendAlert(alertPayload);

      // Mark alert as sent
      await this.prisma.newsMarketMatch.update({
        where: { id: match.id },
        data: {
          alertSent: true,
          alertSentAt: new Date(),
        },
      });

      this.logger.info('Alert sent', {
        articleId: article.id,
        marketTitle: match.market.title,
        confidence: validation.suggestedConfidence,
      });
    } catch (error) {
      this.logger.error('Failed to send alert', {
        articleId: article.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  protected async onStart(): Promise<void> {
    this.logger.info('Validation worker initialized', {
      minConfidence: this.minConfidence,
      alertsEnabled: !!this.alertService,
    });
  }
}
