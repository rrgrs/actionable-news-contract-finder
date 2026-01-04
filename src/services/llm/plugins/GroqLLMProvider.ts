import axios, { AxiosInstance } from 'axios';
import { LLMProvider, LLMProviderConfig, LLMProviderPlugin } from '../../../types';
import { RateLimiter, withRateLimit } from '../../../utils/rateLimiter';
import { createLogger, Logger } from '../../../utils/logger';

interface GroqMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface GroqCompletionRequest {
  model: string;
  messages: GroqMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stream?: boolean;
  response_format?: { type: 'json_object' };
}

interface GroqCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_time: number;
    completion_time: number;
    total_time: number;
  };
}

type GroqModelKey =
  | 'llama3-70b-8192'
  | 'llama3-8b-8192'
  | 'llama-3.3-70b-versatile'
  | 'llama-3.2-90b-text-preview'
  | 'mixtral-8x7b-32768'
  | 'gemma-7b-it'
  | 'gemma2-9b-it';

export class GroqLLMProvider implements LLMProvider {
  name = 'groq';
  private apiKey: string = '';
  private baseUrl = 'https://api.groq.com/openai/v1';
  private client!: AxiosInstance;
  private model: string = 'llama-3.3-70b-versatile'; // Default to Llama 3.3 70B Versatile
  private temperature: number = 0.7;
  private maxTokens: number = 4096;
  private rateLimiter!: RateLimiter;
  private logger: Logger;

  // Available Groq models (as of 2024)
  private readonly availableModels: Record<GroqModelKey, string> = {
    'llama3-70b-8192': 'Meta Llama 3 70B (8K context)',
    'llama3-8b-8192': 'Meta Llama 3 8B (8K context)',
    'llama-3.3-70b-versatile': 'Meta Llama 3.3 70B Versatile',
    'llama-3.2-90b-text-preview': 'Meta Llama 3.2 90B Text Preview',
    'mixtral-8x7b-32768': 'Mixtral 8x7B (32K context)',
    'gemma-7b-it': 'Google Gemma 7B Instruct',
    'gemma2-9b-it': 'Google Gemma 2 9B Instruct',
  };

  constructor() {
    this.logger = createLogger('Groq');
  }

  async initialize(config: LLMProviderConfig): Promise<void> {
    const customConfig = config.customConfig as Record<string, string | number> | undefined;

    // Get API key from config or environment
    this.apiKey =
      config.apiKey || (customConfig?.apiKey as string) || process.env.GROQ_API_KEY || '';

    if (!this.apiKey) {
      throw new Error(
        'Groq API key not provided. Set GROQ_API_KEY in .env or provide in config. ' +
          'Get a free API key at https://console.groq.com/keys',
      );
    }

    // Configure model
    if (customConfig?.model) {
      const modelName = String(customConfig.model);
      if (this.availableModels[modelName as GroqModelKey]) {
        this.model = modelName;
      } else {
        this.logger.warn('Unknown Groq model, using default', {
          requested: modelName,
          default: this.model,
          available: Object.keys(this.availableModels).join(', '),
        });
      }
    }

    // Configure parameters
    if (customConfig?.temperature !== undefined) {
      this.temperature = Math.max(0, Math.min(2, Number(customConfig.temperature)));
    }

    if (customConfig?.maxTokens !== undefined) {
      this.maxTokens = Math.max(1, Math.min(8192, Number(customConfig.maxTokens)));
    }

    // Configure rate limiting
    const rpmLimit = customConfig?.rpmLimit
      ? Math.max(1, Math.min(30, Number(customConfig.rpmLimit)))
      : 25;
    const minDelayMs = customConfig?.requestDelayMs
      ? Math.max(1000, Number(customConfig.requestDelayMs))
      : 2500;

    // Initialize rate limiter (Groq free tier: ~30 requests/minute)
    this.rateLimiter = new RateLimiter(
      {
        minDelayMs,
        requestsPerMinute: rpmLimit,
        maxRetries: 3,
        baseBackoffMs: 60000,
      },
      'Groq',
    );

    // Initialize HTTP client
    this.client = axios.create({
      baseURL: this.baseUrl,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

    this.logger.info('Provider initialized', {
      model: this.model,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      rpmLimit,
      minDelayMs,
    });
  }

  async generateCompletion(prompt: string, systemPrompt?: string): Promise<string> {
    const messages: GroqMessage[] = [];

    if (systemPrompt) {
      messages.push({
        role: 'system',
        content: systemPrompt,
      });
    }

    messages.push({
      role: 'user',
      content: prompt,
    });

    const request: GroqCompletionRequest = {
      model: this.model,
      messages,
      temperature: this.temperature,
      max_tokens: this.maxTokens,
      stream: false,
    };

    // If the prompt asks for JSON, enable JSON mode
    if (prompt.toLowerCase().includes('json') || systemPrompt?.toLowerCase().includes('json')) {
      request.response_format = { type: 'json_object' };
    }

    try {
      const response = await withRateLimit(this.rateLimiter, () =>
        this.client.post<GroqCompletionResponse>('/chat/completions', request),
      );

      // Update rate limit info from response headers
      this.rateLimiter.updateFromHeaders(response.headers as Record<string, unknown>);

      if (response.data.choices && response.data.choices.length > 0) {
        const content = response.data.choices[0].message.content;

        // Log performance metrics
        if (response.data.usage) {
          const tokensPerSecond =
            response.data.usage.completion_tokens / response.data.usage.completion_time;

          this.logger.debug('Completion successful', {
            totalTokens: response.data.usage.total_tokens,
            promptTokens: response.data.usage.prompt_tokens,
            completionTokens: response.data.usage.completion_tokens,
            totalTime: response.data.usage.total_time.toFixed(2),
            tokensPerSecond: tokensPerSecond.toFixed(0),
          });
        }

        return content;
      }

      throw new Error('No completion generated');
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 401) {
          throw new Error('Invalid Groq API key. Please check your configuration.');
        }
        if (error.response?.data?.error) {
          throw new Error(`Groq API error: ${error.response.data.error.message}`);
        }
      }
      this.logger.error('Error generating completion', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async generateStructuredOutput<T = unknown>(
    prompt: string,
    schema: Record<string, unknown>,
    systemPrompt?: string,
  ): Promise<T> {
    // Groq supports JSON mode, so we can use it for structured output
    const enhancedSystemPrompt = `${systemPrompt || ''}
You must respond with valid JSON that matches this schema:
${JSON.stringify(schema, null, 2)}`;

    const enhancedPrompt = `${prompt}

Remember to respond ONLY with valid JSON, no additional text.`;

    const response = await this.generateCompletion(enhancedPrompt, enhancedSystemPrompt);

    try {
      // Try to parse the JSON response
      return JSON.parse(response) as T;
    } catch (error) {
      this.logger.error('Failed to parse JSON response', {
        error: error instanceof Error ? error.message : String(error),
        response: response.substring(0, 200),
      });

      // Try to extract JSON from the response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[0]) as T;
        } catch {
          throw new Error('Failed to parse JSON from Groq response');
        }
      }

      throw new Error('Groq did not return valid JSON');
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      const response = await this.client.get('/models', {
        timeout: 5000,
      });

      return response.status === 200 && response.data.data?.length > 0;
    } catch (error) {
      this.logger.error('Health check failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async destroy(): Promise<void> {
    this.logger.info('Provider destroyed');
  }
}

export const GroqLLMProviderPlugin: LLMProviderPlugin = {
  create: (_config: LLMProviderConfig) => {
    const provider = new GroqLLMProvider();
    return provider;
  },
};
