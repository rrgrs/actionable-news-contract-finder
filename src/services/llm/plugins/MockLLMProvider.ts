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
    schema: any,
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
