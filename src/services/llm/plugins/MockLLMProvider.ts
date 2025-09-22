import { LLMProvider, LLMProviderConfig, LLMProviderPlugin } from '../../../types';

export class MockLLMProvider implements LLMProvider {
  name: string;
  private isInitialized = false;

  constructor(config: LLMProviderConfig) {
    this.name = config.name;
  }

  async initialize(config: LLMProviderConfig): Promise<void> {
    this.isInitialized = true;
    console.log(`MockLLMProvider initialized: ${config.name}`);
  }

  async generateCompletion(prompt: string, _systemPrompt?: string): Promise<string> {
    if (!this.isInitialized) {
      throw new Error('Provider not initialized');
    }

    console.log('Mock LLM generating completion for prompt:', prompt.substring(0, 100) + '...');

    // Check if the prompt is asking for JSON structure
    if (prompt.includes('return a JSON response') || prompt.includes('JSON')) {
      // Return a properly formatted JSON response for news parsing
      if (prompt.includes('Federal Reserve') || prompt.includes('rate cut')) {
        return JSON.stringify({
          entities: [
            {
              type: 'organization',
              name: 'Federal Reserve',
              confidence: 0.95,
              context: 'Central bank making rate decision',
            },
            {
              type: 'commodity',
              name: 'US Dollar',
              confidence: 0.85,
              context: 'Currency affected by rate decision',
            },
          ],
          events: [
            {
              type: 'economic',
              description: 'Federal Reserve announces rate cut',
              date: new Date().toISOString(),
              probability: 0.9,
              impact: 'high',
            },
          ],
          predictions: [
            {
              outcome: 'Stock market rally continues',
              probability: 0.75,
              timeframe: '1-7 days',
              confidence: 0.8,
              reasoning: 'Lower rates typically boost equities',
            },
            {
              outcome: 'Dollar weakens against major currencies',
              probability: 0.7,
              timeframe: '1-3 months',
              confidence: 0.75,
              reasoning: 'Rate cuts reduce currency yield',
            },
          ],
          sentiment: { overall: 0.6, positive: 0.7, negative: 0.2, neutral: 0.1 },
          suggestedActions: [
            {
              type: 'bet',
              description: 'Consider YES on Fed rate cut markets',
              urgency: 'high',
              relatedMarketQuery: 'fed rate',
              confidence: 0.85,
            },
          ],
          relevanceScore: 0.9,
          summary: 'Federal Reserve cuts rates, signaling dovish monetary policy stance',
        });
      }

      if (prompt.includes('Tesla') || prompt.includes('battery')) {
        return JSON.stringify({
          entities: [
            {
              type: 'organization',
              name: 'Tesla',
              confidence: 0.98,
              context: 'Electric vehicle manufacturer',
            },
            {
              type: 'technology',
              name: 'Battery Technology',
              confidence: 0.9,
              context: 'New battery breakthrough',
            },
          ],
          events: [
            {
              type: 'technology',
              description: 'Tesla announces battery breakthrough',
              date: new Date().toISOString(),
              probability: 0.95,
              impact: 'high',
            },
          ],
          predictions: [
            {
              outcome: 'Tesla stock price increases',
              probability: 0.8,
              timeframe: '1-7 days',
              confidence: 0.75,
              reasoning: 'Battery breakthrough improves competitive position',
            },
            {
              outcome: 'EV adoption accelerates',
              probability: 0.7,
              timeframe: '6-12 months',
              confidence: 0.65,
              reasoning: 'Better range and cost addresses key barriers',
            },
          ],
          sentiment: { overall: 0.8, positive: 0.85, negative: 0.1, neutral: 0.05 },
          suggestedActions: [
            {
              type: 'bet',
              description: 'Consider Tesla stock price markets',
              urgency: 'high',
              relatedMarketQuery: 'tesla stock',
              confidence: 0.8,
            },
          ],
          relevanceScore: 0.85,
          summary: 'Tesla battery breakthrough with 50% range increase and 30% cost reduction',
        });
      }

      // Default JSON response
      return JSON.stringify({
        entities: [],
        events: [],
        predictions: [],
        sentiment: { overall: 0, positive: 0.33, negative: 0.33, neutral: 0.34 },
        suggestedActions: [],
        relevanceScore: 0.3,
        summary: 'News item analyzed',
      });
    }

    // Non-JSON responses for other prompts
    if (prompt.includes('Federal Reserve') || prompt.includes('rate cut')) {
      return 'Based on the news about the Federal Reserve rate cut, this indicates a dovish monetary policy stance. Key implications: 1) Lower borrowing costs for businesses and consumers, 2) Potential stock market rally, 3) Weakening of the US dollar, 4) Increased inflation expectations. This could affect interest rate futures, bank stocks, and bond yields.';
    }

    if (prompt.includes('Tesla') || prompt.includes('battery')) {
      return "Tesla's battery breakthrough represents a significant technological advancement. Key points: 1) 50% increase in range addresses range anxiety, 2) 30% cost reduction improves affordability, 3) Q2 2025 production timeline suggests near-term implementation, 4) Competitive advantage over other EV manufacturers. This could impact Tesla stock, EV sector ETFs, and lithium/battery material commodities.";
    }

    return 'This news event has moderate market implications. Further analysis recommended to identify specific trading opportunities.';
  }

  async generateStructuredOutput<T>(
    _prompt: string,
    schema: unknown,
    _systemPrompt?: string,
  ): Promise<T> {
    if (!this.isInitialized) {
      throw new Error('Provider not initialized');
    }

    console.log('Mock LLM generating structured output for schema:', schema);

    const mockStructuredResponse = {
      summary: 'Important market-moving news detected',
      entities: [
        { type: 'organization', name: 'Federal Reserve', confidence: 0.95 },
        { type: 'event', name: 'Interest Rate Decision', confidence: 0.9 },
      ],
      predictions: [
        { outcome: 'Market rally continues', probability: 0.7, confidence: 0.8 },
        { outcome: 'Dollar weakens', probability: 0.65, confidence: 0.75 },
      ],
      suggestedActions: [
        {
          type: 'bet',
          description: 'Consider YES position on Fed rate cut markets',
          urgency: 'high',
          confidence: 0.85,
        },
      ],
    };

    return mockStructuredResponse as T;
  }

  async isHealthy(): Promise<boolean> {
    return this.isInitialized;
  }

  async destroy(): Promise<void> {
    this.isInitialized = false;
    console.log('MockLLMProvider destroyed');
  }
}

export const MockLLMProviderPlugin: LLMProviderPlugin = {
  create(config: LLMProviderConfig): LLMProvider {
    return new MockLLMProvider(config);
  },
};
