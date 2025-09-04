import {
  NewsParser,
  NewsItem,
  ParsedNewsInsight,
  LLMProvider,
  Entity,
  Event,
  Prediction,
  Sentiment,
  SuggestedAction,
} from '../../types';

export class NewsParserService implements NewsParser {
  async parseNews(newsItem: NewsItem, llmProvider: LLMProvider): Promise<ParsedNewsInsight> {
    const systemPrompt = `You are a financial news analyst. Analyze news for market implications and betting opportunities.
Focus on: entities, events, predictions, sentiment, and actionable insights.`;

    const prompt = `Analyze this news item for market implications:
Title: ${newsItem.title}
Content: ${newsItem.content}
Published: ${newsItem.publishedAt}
Tags: ${newsItem.tags?.join(', ') || 'none'}

Extract:
1. Key entities (people, organizations, locations)
2. Important events and their dates
3. Market predictions with probabilities
4. Sentiment analysis
5. Suggested betting actions`;

    const analysis = await llmProvider.generateCompletion(prompt, systemPrompt);

    const insight: ParsedNewsInsight = {
      originalNewsId: newsItem.id,
      summary: newsItem.summary || newsItem.title,
      entities: this.extractEntities(analysis),
      events: this.extractEvents(analysis),
      predictions: this.extractPredictions(analysis),
      sentiment: this.analyzeSentiment(analysis),
      relevanceScore: this.calculateRelevance(newsItem, analysis),
      suggestedActions: this.extractSuggestedActions(analysis),
      metadata: {
        processedAt: new Date(),
        source: newsItem.source,
      },
    };

    return insight;
  }

  async batchParseNews(
    newsItems: NewsItem[],
    llmProvider: LLMProvider,
  ): Promise<ParsedNewsInsight[]> {
    const insights = await Promise.all(newsItems.map((item) => this.parseNews(item, llmProvider)));
    return insights;
  }

  private extractEntities(analysis: string): Entity[] {
    const entities: Entity[] = [];

    if (analysis.includes('Federal Reserve') || analysis.includes('Fed')) {
      entities.push({
        type: 'organization',
        name: 'Federal Reserve',
        confidence: 0.95,
        context: 'Central banking authority',
      });
    }

    if (analysis.includes('Tesla')) {
      entities.push({
        type: 'organization',
        name: 'Tesla',
        confidence: 0.95,
        context: 'Electric vehicle manufacturer',
      });
    }

    return entities;
  }

  private extractEvents(analysis: string): Event[] {
    const events: Event[] = [];

    if (analysis.includes('rate cut')) {
      events.push({
        type: 'monetary_policy',
        description: 'Federal Reserve interest rate cut',
        probability: 0.8,
        impact: 'high',
      });
    }

    if (analysis.includes('battery breakthrough')) {
      events.push({
        type: 'technology',
        description: 'Battery technology advancement',
        probability: 0.75,
        impact: 'medium',
      });
    }

    return events;
  }

  private extractPredictions(analysis: string): Prediction[] {
    const predictions: Prediction[] = [];

    if (analysis.includes('rally') || analysis.includes('market up')) {
      predictions.push({
        outcome: 'Stock market rally',
        probability: 0.7,
        timeframe: 'Short-term (1-3 months)',
        confidence: 0.75,
        reasoning: 'Monetary policy easing typically supports equity markets',
      });
    }

    return predictions;
  }

  private analyzeSentiment(analysis: string): Sentiment {
    let positive = 0;
    let negative = 0;

    const positiveWords = ['rally', 'breakthrough', 'increase', 'improve', 'advance'];
    const negativeWords = ['concern', 'decline', 'risk', 'threat', 'worry'];

    positiveWords.forEach((word) => {
      if (analysis.toLowerCase().includes(word)) {
        positive++;
      }
    });

    negativeWords.forEach((word) => {
      if (analysis.toLowerCase().includes(word)) {
        negative++;
      }
    });

    const total = positive + negative || 1;

    return {
      overall: (positive - negative) / total,
      positive: positive / total,
      negative: negative / total,
      neutral: 1 - (positive + negative) / total,
    };
  }

  private calculateRelevance(newsItem: NewsItem, analysis: string): number {
    let score = 0.5;

    if (newsItem.metadata?.importance === 'high') {
      score += 0.2;
    }
    if (analysis.includes('significant') || analysis.includes('major')) {
      score += 0.15;
    }
    if (newsItem.tags && newsItem.tags.length > 2) {
      score += 0.1;
    }

    return Math.min(score, 1.0);
  }

  private extractSuggestedActions(analysis: string): SuggestedAction[] {
    const actions: SuggestedAction[] = [];

    if (analysis.includes('rate cut') || analysis.includes('Fed')) {
      actions.push({
        type: 'bet',
        description: 'Consider positions on interest rate futures or Fed policy markets',
        urgency: 'high',
        relatedMarketQuery: 'federal reserve rate cut',
        confidence: 0.8,
      });
    }

    if (analysis.includes('Tesla') || analysis.includes('battery')) {
      actions.push({
        type: 'bet',
        description: 'Look for Tesla stock price or EV sector markets',
        urgency: 'medium',
        relatedMarketQuery: 'tesla stock price',
        confidence: 0.75,
      });
    }

    return actions;
  }
}
