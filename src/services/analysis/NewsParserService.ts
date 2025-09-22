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

interface LLMAnalysisResponse {
  entities: Array<{
    type: string;
    name: string;
    confidence: number;
    context?: string;
  }>;
  events: Array<{
    type: string;
    description: string;
    date?: string;
    probability: number;
    impact: 'low' | 'medium' | 'high';
  }>;
  predictions: Array<{
    outcome: string;
    probability: number;
    timeframe: string;
    confidence: number;
    reasoning: string;
  }>;
  sentiment: {
    overall: number;
    positive: number;
    negative: number;
    neutral: number;
  };
  suggestedActions: Array<{
    type: string;
    description: string;
    urgency: 'low' | 'medium' | 'high';
    relatedMarketQuery: string;
    confidence: number;
  }>;
  relevanceScore: number;
  summary: string;
}

export class NewsParserService implements NewsParser {
  async parseNews(newsItem: NewsItem, llmProvider: LLMProvider): Promise<ParsedNewsInsight> {
    const systemPrompt = `You are an advanced news analysis AI. Analyze news articles to extract structured insights for decision-making.
You must respond with valid JSON that matches the exact structure provided. Be thorough and identify ALL relevant entities, events, and market implications.`;

    const prompt = `Analyze this news item and return a JSON response with the following structure:
{
  "entities": [
    {
      "type": "person|organization|location|product|technology|currency|commodity",
      "name": "Entity Name",
      "confidence": 0.0-1.0,
      "context": "Brief description of entity's role in the news"
    }
  ],
  "events": [
    {
      "type": "economic|political|technology|business|regulatory|social|environmental|other",
      "description": "Clear description of the event",
      "date": "ISO date if mentioned or null",
      "probability": 0.0-1.0,
      "impact": "low|medium|high"
    }
  ],
  "predictions": [
    {
      "outcome": "Specific predicted outcome",
      "probability": 0.0-1.0,
      "timeframe": "e.g., '1-7 days', '1-3 months', '6-12 months'",
      "confidence": 0.0-1.0,
      "reasoning": "Why this prediction is made"
    }
  ],
  "sentiment": {
    "overall": -1.0 to 1.0 (negative to positive),
    "positive": 0.0-1.0,
    "negative": 0.0-1.0,
    "neutral": 0.0-1.0
  },
  "suggestedActions": [
    {
      "type": "bet|monitor|research|ignore",
      "description": "Specific action to take",
      "urgency": "low|medium|high",
      "relatedMarketQuery": "Search query for relevant markets (optional)",
      "confidence": 0.0-1.0
    }
  ],
  "relevanceScore": 0.0-1.0 (how relevant for market/betting opportunities),
  "summary": "2-3 sentence summary of key implications"
}

News Item to Analyze:
Title: ${newsItem.title}
Content: ${newsItem.content}
Source: ${newsItem.source}
Published: ${newsItem.publishedAt}
Tags: ${newsItem.tags?.join(', ') || 'none'}
${newsItem.metadata ? `Additional Context: ${JSON.stringify(newsItem.metadata)}` : ''}

Focus on:
1. ALL mentioned entities (people, companies, organizations, locations, products, etc.)
2. Current and potential future events
3. Market predictions and probabilities
4. Overall sentiment and market implications
5. Actionable opportunities for betting/prediction markets
6. Consider both direct and indirect market impacts

Return ONLY valid JSON, no additional text.`;

    try {
      const analysis = await llmProvider.generateCompletion(prompt, systemPrompt);

      // Parse the LLM response
      const parsedAnalysis = this.parseJSONResponse(analysis);

      const insight: ParsedNewsInsight = {
        originalNewsId: newsItem.id,
        summary: parsedAnalysis.summary || newsItem.summary || newsItem.title,
        entities: this.validateEntities(parsedAnalysis.entities),
        events: this.validateEvents(parsedAnalysis.events),
        predictions: this.validatePredictions(parsedAnalysis.predictions),
        sentiment: this.validateSentiment(parsedAnalysis.sentiment),
        relevanceScore: this.validateRelevanceScore(parsedAnalysis.relevanceScore),
        suggestedActions: this.validateSuggestedActions(parsedAnalysis.suggestedActions),
        metadata: {
          processedAt: new Date(),
          source: newsItem.source,
          llmModel: llmProvider.name,
        },
      };

      return insight;
    } catch (error) {
      console.error('Error parsing news with LLM:', error);
      // Fallback to basic analysis if LLM fails
      return this.createFallbackInsight(newsItem);
    }
  }

  async batchParseNews(
    newsItems: NewsItem[],
    llmProvider: LLMProvider,
  ): Promise<ParsedNewsInsight[]> {
    // Process multiple news items in a single LLM request to reduce API calls
    const batchSize = 5; // Process up to 5 news items at once
    const results: ParsedNewsInsight[] = [];

    console.log(`📦 Batch processing ${newsItems.length} news items in batches of ${batchSize}`);

    for (let i = 0; i < newsItems.length; i += batchSize) {
      const batch = newsItems.slice(i, i + batchSize);

      try {
        // Process entire batch in a single LLM call
        const batchResults = await this.parseBatchInSingleRequest(batch, llmProvider);
        results.push(...batchResults);

        console.log(
          `✅ Processed batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(newsItems.length / batchSize)} (${batchResults.length} items)`,
        );
      } catch (error) {
        console.error(`Error processing batch, falling back to individual processing:`, error);
        // Fallback to individual processing if batch fails
        const individualResults = await Promise.all(
          batch.map((item) => this.parseNews(item, llmProvider)),
        );
        results.push(...individualResults);
      }
    }

    return results;
  }

  private async parseBatchInSingleRequest(
    newsItems: NewsItem[],
    llmProvider: LLMProvider,
  ): Promise<ParsedNewsInsight[]> {
    const systemPrompt = `You are an advanced news analysis AI. Analyze multiple news articles in a single batch to extract structured insights.
You must respond with a JSON array where each element matches the exact structure provided. Be efficient but thorough.`;

    const batchPrompt = `Analyze these ${newsItems.length} news items and return a JSON array with one analysis object per news item.

Each object in the array should have this structure:
{
  "newsId": "the original news ID",
  "entities": [...],
  "events": [...],
  "predictions": [...],
  "sentiment": {...},
  "suggestedActions": [...],
  "relevanceScore": 0.0-1.0,
  "summary": "2-3 sentence summary"
}

News Items to Analyze:
${newsItems
  .map(
    (item, index) => `
[NEWS ITEM ${index + 1}]
ID: ${item.id}
Title: ${item.title}
Content: ${item.content.substring(0, 500)}${item.content.length > 500 ? '...' : ''}
Source: ${item.source}
Published: ${item.publishedAt}
Tags: ${item.tags?.join(', ') || 'none'}
`,
  )
  .join('\n---\n')}

Analyze ALL ${newsItems.length} items and return a JSON array with ${newsItems.length} analysis objects.
Focus on identifying market opportunities and actionable insights for each item.

Return ONLY valid JSON array, no additional text.`;

    try {
      const batchAnalysis = await llmProvider.generateCompletion(batchPrompt, systemPrompt);

      // Parse the batch response
      const parsedBatch = this.parseBatchJSONResponse(batchAnalysis);

      // If parsing failed completely, fall back to individual processing
      if (parsedBatch.length === 0) {
        console.warn('Batch parsing failed, falling back to individual processing');
        const fallbackInsights: ParsedNewsInsight[] = [];
        for (const newsItem of newsItems) {
          try {
            const insight = await this.parseNews(newsItem, llmProvider);
            fallbackInsights.push(insight);
          } catch (err) {
            console.error(`Failed to process news item ${newsItem.id}:`, err);
          }
        }
        return fallbackInsights;
      }

      // Map each analysis to its corresponding news item
      const insights: ParsedNewsInsight[] = [];

      for (let i = 0; i < newsItems.length; i++) {
        const newsItem = newsItems[i];
        const analysis = parsedBatch[i] || this.createEmptyAnalysis();

        // Verify the analysis matches the news item
        if (analysis.newsId && analysis.newsId !== newsItem.id) {
          console.warn(`Analysis ID mismatch: expected ${newsItem.id}, got ${analysis.newsId}`);
        }

        const insight: ParsedNewsInsight = {
          originalNewsId: newsItem.id,
          summary: analysis.summary || newsItem.summary || newsItem.title,
          entities: this.validateEntities(analysis.entities),
          events: this.validateEvents(analysis.events),
          predictions: this.validatePredictions(analysis.predictions),
          sentiment: this.validateSentiment(analysis.sentiment),
          relevanceScore: this.validateRelevanceScore(analysis.relevanceScore),
          suggestedActions: this.validateSuggestedActions(analysis.suggestedActions),
          metadata: {
            processedAt: new Date(),
            source: newsItem.source,
            llmModel: llmProvider.name,
            batchProcessed: true,
            batchSize: newsItems.length,
          },
        };

        insights.push(insight);
      }

      return insights;
    } catch (error) {
      console.error('Error in batch processing:', error);
      throw error;
    }
  }

  private parseBatchJSONResponse(
    response: string,
  ): Array<LLMAnalysisResponse & { newsId?: string }> {
    // Try to extract JSON array from the response
    let jsonStr = response.trim();

    // Handle markdown code blocks
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    }

    // Find array boundaries more carefully
    // Look for the first '[' and find its matching ']'
    const arrayStart = jsonStr.indexOf('[');
    if (arrayStart === -1) {
      console.error('No JSON array found in batch response');
      return [];
    }

    // Find the matching closing bracket by counting depth
    let depth = 0;
    let arrayEnd = -1;
    let inString = false;
    let escapeNext = false;

    for (let i = arrayStart; i < jsonStr.length; i++) {
      const char = jsonStr[i];

      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      if (char === '\\') {
        escapeNext = true;
        continue;
      }

      if (char === '"' && !escapeNext) {
        inString = !inString;
        continue;
      }

      if (!inString) {
        if (char === '[' || char === '{') {
          depth++;
        } else if (char === ']' || char === '}') {
          depth--;
          if (depth === 0 && char === ']') {
            arrayEnd = i;
            break;
          }
        }
      }
    }

    if (arrayEnd === -1) {
      console.error('Malformed JSON array - no matching closing bracket');
      return [];
    }

    jsonStr = jsonStr.substring(arrayStart, arrayEnd + 1);

    try {
      const parsed = JSON.parse(jsonStr);
      if (!Array.isArray(parsed)) {
        console.error('Batch response is not an array');
        return [];
      }
      return parsed;
    } catch (error) {
      console.error('Failed to parse batch JSON response:', error);
      console.error('Attempted to parse:', jsonStr.substring(0, 200) + '...');
      return [];
    }
  }

  private createEmptyAnalysis(): LLMAnalysisResponse & { newsId?: string } {
    return {
      entities: [],
      events: [],
      predictions: [],
      sentiment: { overall: 0, positive: 0, negative: 0, neutral: 1 },
      suggestedActions: [],
      relevanceScore: 0.5,
      summary: '',
    };
  }

  private parseJSONResponse(response: string): LLMAnalysisResponse {
    // Try to extract JSON from the response
    let jsonStr = response.trim();

    // Handle case where LLM wraps JSON in markdown code blocks
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1];
    }

    // Handle case where LLM includes text before/after JSON
    const jsonStart = jsonStr.indexOf('{');
    const jsonEnd = jsonStr.lastIndexOf('}');
    if (jsonStart !== -1 && jsonEnd !== -1) {
      jsonStr = jsonStr.substring(jsonStart, jsonEnd + 1);
    }

    try {
      return JSON.parse(jsonStr) as LLMAnalysisResponse;
    } catch (error) {
      console.error('Failed to parse LLM JSON response:', error);
      console.error('Response was:', jsonStr);
      // Return empty structure
      return {
        entities: [],
        events: [],
        predictions: [],
        sentiment: { overall: 0, positive: 0, negative: 0, neutral: 1 },
        suggestedActions: [],
        relevanceScore: 0.5,
        summary: '',
      };
    }
  }

  private validateEntities(entities: unknown): Entity[] {
    if (!Array.isArray(entities)) {
      return [];
    }

    return entities
      .filter((e) => {
        return (
          typeof e === 'object' &&
          e !== null &&
          typeof e.type === 'string' &&
          typeof e.name === 'string'
        );
      })
      .map((e) => {
        const entity = e as Record<string, unknown>;
        return {
          type: entity.type as 'person' | 'organization' | 'location' | 'other',
          name: entity.name as string,
          confidence:
            typeof entity.confidence === 'number'
              ? Math.max(0, Math.min(1, entity.confidence))
              : 0.5,
          context: entity.context as string | undefined,
        };
      });
  }

  private validateEvents(events: unknown): Event[] {
    if (!Array.isArray(events)) {
      return [];
    }

    return events
      .filter((e): e is Event => {
        return (
          typeof e === 'object' &&
          e !== null &&
          typeof e.type === 'string' &&
          typeof e.description === 'string'
        );
      })
      .map((e) => {
        let eventDate: Date | undefined;
        if (e.date) {
          const parsed = new Date(e.date);
          eventDate = isNaN(parsed.getTime()) ? undefined : parsed;
        }
        return {
          type: e.type,
          description: e.description,
          date: eventDate,
          probability:
            typeof e.probability === 'number' ? Math.max(0, Math.min(1, e.probability)) : 0.5,
          impact: (['low', 'medium', 'high'].includes(e.impact as string) ? e.impact : 'medium') as
            | 'low'
            | 'medium'
            | 'high',
        };
      });
  }

  private validatePredictions(predictions: unknown): Prediction[] {
    if (!Array.isArray(predictions)) {
      return [];
    }

    return predictions
      .filter((p): p is Prediction => {
        return (
          typeof p === 'object' &&
          p !== null &&
          typeof p.outcome === 'string' &&
          typeof p.probability === 'number'
        );
      })
      .map((p) => ({
        outcome: p.outcome,
        probability: Math.max(0, Math.min(1, p.probability)),
        timeframe: p.timeframe || 'Unknown',
        confidence: typeof p.confidence === 'number' ? Math.max(0, Math.min(1, p.confidence)) : 0.5,
        reasoning: p.reasoning || '',
      }));
  }

  private validateSentiment(sentiment: unknown): Sentiment {
    const defaultSentiment = { overall: 0, positive: 0, negative: 0, neutral: 1 };

    if (typeof sentiment !== 'object' || sentiment === null) {
      return defaultSentiment;
    }

    const s = sentiment as Record<string, unknown>;
    return {
      overall: typeof s.overall === 'number' ? Math.max(-1, Math.min(1, s.overall)) : 0,
      positive: typeof s.positive === 'number' ? Math.max(0, Math.min(1, s.positive)) : 0,
      negative: typeof s.negative === 'number' ? Math.max(0, Math.min(1, s.negative)) : 0,
      neutral: typeof s.neutral === 'number' ? Math.max(0, Math.min(1, s.neutral)) : 1,
    };
  }

  private validateRelevanceScore(score: unknown): number {
    if (typeof score !== 'number') {
      return 0.5;
    }
    return Math.max(0, Math.min(1, score));
  }

  private validateSuggestedActions(actions: unknown): SuggestedAction[] {
    if (!Array.isArray(actions)) {
      return [];
    }

    return actions
      .filter((a): a is SuggestedAction => {
        return (
          typeof a === 'object' &&
          a !== null &&
          typeof a.type === 'string' &&
          typeof a.description === 'string'
        );
      })
      .map((a) => ({
        type: a.type as 'bet' | 'monitor' | 'research' | 'ignore',
        description: a.description,
        urgency: (['low', 'medium', 'high'].includes(a.urgency as string)
          ? a.urgency
          : 'medium') as 'low' | 'medium' | 'high',
        relatedMarketQuery: a.relatedMarketQuery,
        confidence: typeof a.confidence === 'number' ? Math.max(0, Math.min(1, a.confidence)) : 0.5,
      }));
  }

  private createFallbackInsight(newsItem: NewsItem): ParsedNewsInsight {
    // Basic fallback analysis when LLM fails
    const content = `${newsItem.title} ${newsItem.content}`.toLowerCase();

    // Simple sentiment based on word counts
    const positiveWords = [
      'gain',
      'rise',
      'increase',
      'improve',
      'success',
      'win',
      'profit',
      'growth',
    ];
    const negativeWords = [
      'loss',
      'fall',
      'decrease',
      'decline',
      'fail',
      'lose',
      'deficit',
      'crash',
    ];

    let posCount = 0;
    let negCount = 0;

    positiveWords.forEach((word) => {
      if (content.includes(word)) {
        posCount++;
      }
    });

    negativeWords.forEach((word) => {
      if (content.includes(word)) {
        negCount++;
      }
    });

    const total = posCount + negCount || 1;
    const sentiment: Sentiment = {
      overall: (posCount - negCount) / total,
      positive: posCount / total,
      negative: negCount / total,
      neutral: Math.max(0, 1 - (posCount + negCount) / total),
    };

    return {
      originalNewsId: newsItem.id,
      summary: newsItem.summary || newsItem.title,
      entities: [],
      events: [],
      predictions: [],
      sentiment,
      relevanceScore: 0.5,
      suggestedActions: [],
      metadata: {
        processedAt: new Date(),
        source: newsItem.source,
        fallbackAnalysis: true,
      },
    };
  }
}
