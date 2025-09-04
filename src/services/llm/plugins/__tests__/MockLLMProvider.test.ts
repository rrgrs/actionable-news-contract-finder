import { MockLLMProvider, MockLLMProviderPlugin } from '../MockLLMProvider';
import { LLMProviderConfig } from '../../../../types';

describe('MockLLMProvider', () => {
  let provider: MockLLMProvider;
  let config: LLMProviderConfig;

  beforeEach(() => {
    config = {
      name: 'mock-llm',
      temperature: 0.7,
      maxTokens: 2000,
    };
    provider = new MockLLMProvider(config);
  });

  describe('initialization', () => {
    it('should initialize successfully', async () => {
      await expect(provider.initialize(config)).resolves.not.toThrow();
      await expect(provider.isHealthy()).resolves.toBe(true);
    });

    it('should set the provider name', () => {
      expect(provider.name).toBe('mock-llm');
    });
  });

  describe('generateCompletion', () => {
    it('should generate completion for Federal Reserve prompt', async () => {
      await provider.initialize(config);

      const prompt = 'What are the implications of the Federal Reserve rate cut?';
      const completion = await provider.generateCompletion(prompt);

      expect(completion).toContain('Federal Reserve');
      expect(completion).toContain('monetary policy');
    });

    it('should generate completion for Tesla prompt', async () => {
      await provider.initialize(config);

      const prompt = 'Analyze Tesla battery technology breakthrough';
      const completion = await provider.generateCompletion(prompt);

      expect(completion).toContain('Tesla');
      expect(completion).toContain('battery');
    });

    it('should generate generic completion for other prompts', async () => {
      await provider.initialize(config);

      const prompt = 'Random market news';
      const completion = await provider.generateCompletion(prompt);

      expect(completion).toContain('market implications');
    });

    it('should accept optional system prompt', async () => {
      await provider.initialize(config);

      const prompt = 'Test prompt';
      const systemPrompt = 'You are a helpful assistant';

      await expect(provider.generateCompletion(prompt, systemPrompt)).resolves.toBeDefined();
    });

    it('should throw error when not initialized', async () => {
      await expect(provider.generateCompletion('test')).rejects.toThrow('Provider not initialized');
    });
  });

  describe('generateStructuredOutput', () => {
    it('should generate structured output', async () => {
      await provider.initialize(config);

      interface TestSchema {
        summary: string;
        entities: Array<{ type: string; name: string }>;
      }

      const schema = { type: 'object' };
      const result = await provider.generateStructuredOutput<TestSchema>('test', schema);

      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('entities');
      expect(result.entities).toBeInstanceOf(Array);
    });

    it('should return consistent structure', async () => {
      await provider.initialize(config);

      const result = await provider.generateStructuredOutput('test', {});

      expect(result).toMatchObject({
        summary: expect.any(String),
        entities: expect.arrayContaining([
          expect.objectContaining({
            type: expect.any(String),
            name: expect.any(String),
            confidence: expect.any(Number),
          }),
        ]),
        predictions: expect.any(Array),
        suggestedActions: expect.any(Array),
      });
    });

    it('should throw error when not initialized', async () => {
      await expect(provider.generateStructuredOutput('test', {})).rejects.toThrow(
        'Provider not initialized',
      );
    });
  });

  describe('destroy', () => {
    it('should destroy the provider', async () => {
      await provider.initialize(config);
      await provider.destroy();

      await expect(provider.isHealthy()).resolves.toBe(false);
    });
  });
});

describe('MockLLMProviderPlugin', () => {
  it('should create a MockLLMProvider instance', () => {
    const config: LLMProviderConfig = {
      name: 'mock-llm',
    };

    const provider = MockLLMProviderPlugin.create(config);

    expect(provider).toBeInstanceOf(MockLLMProvider);
    expect(provider.name).toBe('mock-llm');
  });
});
