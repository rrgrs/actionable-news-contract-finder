import axios, { AxiosInstance } from 'axios';
import { LLMProvider, LLMProviderConfig, LLMProviderPlugin } from '../../../types';

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
  | 'mixtral-8x7b-32768'
  | 'gemma-7b-it'
  | 'gemma2-9b-it';

export class GroqLLMProvider implements LLMProvider {
  name = 'groq';
  private apiKey: string = '';
  private baseUrl = 'https://api.groq.com/openai/v1';
  private client!: AxiosInstance;
  private model: string = 'llama3-70b-8192'; // Default to Llama 3 70B
  private temperature: number = 0.7;
  private maxTokens: number = 4096;
  private requestCount = 0;
  private lastRequestTime = Date.now();

  // Available Groq models (as of 2024)
  private readonly availableModels: Record<GroqModelKey, string> = {
    'llama3-70b-8192': 'Meta Llama 3 70B (8K context)',
    'llama3-8b-8192': 'Meta Llama 3 8B (8K context)',
    'mixtral-8x7b-32768': 'Mixtral 8x7B (32K context)',
    'gemma-7b-it': 'Google Gemma 7B Instruct',
    'gemma2-9b-it': 'Google Gemma 2 9B Instruct',
  };

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
        console.warn(`Unknown Groq model: ${modelName}, using default: ${this.model}`);
        console.log('Available models:', Object.keys(this.availableModels).join(', '));
      }
    }

    // Configure parameters
    if (customConfig?.temperature !== undefined) {
      this.temperature = Math.max(0, Math.min(2, Number(customConfig.temperature)));
    }

    if (customConfig?.maxTokens !== undefined) {
      this.maxTokens = Math.max(1, Math.min(8192, Number(customConfig.maxTokens)));
    }

    // Initialize HTTP client
    this.client = axios.create({
      baseURL: this.baseUrl,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000, // 30 second timeout
    });

    console.log(`Groq LLM Provider initialized with model: ${this.model}`);
    console.log(`Model description: ${this.availableModels[this.model as GroqModelKey]}`);
    console.log(`Temperature: ${this.temperature}, Max Tokens: ${this.maxTokens}`);
  }

  async generateCompletion(prompt: string, systemPrompt?: string): Promise<string> {
    try {
      // Rate limiting (Groq free tier: 30 requests per minute)
      await this.enforceRateLimit();

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

      const response = await this.client.post<GroqCompletionResponse>('/chat/completions', request);

      if (response.data.choices && response.data.choices.length > 0) {
        const content = response.data.choices[0].message.content;

        // Log performance metrics
        if (response.data.usage) {
          const tokensPerSecond =
            response.data.usage.completion_tokens / response.data.usage.completion_time;
          console.log(
            `Groq completion: ${response.data.usage.total_tokens} tokens in ${response.data.usage.total_time.toFixed(2)}s ` +
              `(${tokensPerSecond.toFixed(0)} tokens/sec)`,
          );
        }

        return content;
      }

      throw new Error('No completion generated');
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 429) {
          throw new Error('Groq rate limit exceeded. Please wait and try again.');
        }
        if (error.response?.status === 401) {
          throw new Error('Invalid Groq API key. Please check your configuration.');
        }
        if (error.response?.data?.error) {
          throw new Error(`Groq API error: ${error.response.data.error.message}`);
        }
      }
      console.error('Error generating completion with Groq:', error);
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
      console.error('Failed to parse Groq JSON response:', error);
      console.error('Response was:', response);

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

  private async enforceRateLimit(): Promise<void> {
    // Groq free tier: 30 requests per minute, 14,400 per day
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    // If we've made a request in the last 2 seconds, wait
    if (timeSinceLastRequest < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 2000 - timeSinceLastRequest));
    }

    this.requestCount++;
    this.lastRequestTime = Date.now();

    // Reset counter every minute
    if (this.requestCount >= 30) {
      const minuteElapsed = Date.now() - (this.lastRequestTime - 60000);
      if (minuteElapsed < 60000) {
        console.log(
          `Rate limit approaching, waiting ${Math.ceil((60000 - minuteElapsed) / 1000)}s...`,
        );
        await new Promise((resolve) => setTimeout(resolve, 60000 - minuteElapsed));
      }
      this.requestCount = 0;
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      const response = await this.client.get('/models', {
        timeout: 5000,
      });

      return response.status === 200 && response.data.data?.length > 0;
    } catch (error) {
      console.error('Groq health check failed:', error);
      return false;
    }
  }

  async destroy(): Promise<void> {
    console.log('Groq LLM Provider destroyed');
  }
}

export const GroqLLMProviderPlugin: LLMProviderPlugin = {
  create: (_config: LLMProviderConfig) => {
    const provider = new GroqLLMProvider();
    return provider;
  },
};
