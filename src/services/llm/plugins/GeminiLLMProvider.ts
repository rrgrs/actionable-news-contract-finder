import axios, { AxiosInstance } from 'axios';
import { LLMProvider, LLMProviderConfig, LLMProviderPlugin } from '../../../types';
import { RateLimiter, withRateLimit } from '../../../utils/rateLimiter';
import { createLogger, Logger } from '../../../utils/logger';

interface GeminiMessage {
  role: 'user' | 'model';
  parts: Array<{
    text: string;
  }>;
}

interface GeminiGenerationConfig {
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  topK?: number;
}

interface GeminiRequest {
  contents: GeminiMessage[];
  generationConfig?: GeminiGenerationConfig;
  safetySettings?: Array<{
    category: string;
    threshold: string;
  }>;
}

interface GeminiResponse {
  candidates: Array<{
    content: {
      parts: Array<{
        text: string;
      }>;
      role: string;
    };
    finishReason: string;
    index: number;
  }>;
  promptFeedback?: {
    safetyRatings: Array<{
      category: string;
      probability: string;
    }>;
  };
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
}

type GeminiModelKey =
  | 'gemini-3-flash-preview'
  | 'gemini-2.0-flash'
  | 'gemini-1.5-flash'
  | 'gemini-1.5-flash-002'
  | 'gemini-1.5-pro'
  | 'gemini-1.5-pro-002'
  | 'gemini-1.0-pro';

export class GeminiLLMProvider implements LLMProvider {
  name = 'gemini';
  private apiKey: string = '';
  private baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
  private client!: AxiosInstance;
  private model: string = 'gemini-3-flash-preview'; // Default to Gemini 3 Flash Preview
  private temperature: number = 0.7;
  private maxTokens: number = 8192;
  private rateLimiter!: RateLimiter;
  private logger: Logger;

  // Available Gemini models (as of 2025)
  private readonly availableModels: Record<GeminiModelKey, string> = {
    'gemini-3-flash-preview': 'Gemini 3 Flash Preview (Latest, recommended)',
    'gemini-2.0-flash': 'Gemini 2.0 Flash (Fast, multimodal)',
    'gemini-1.5-flash': 'Gemini 1.5 Flash (Fast, 1M context)',
    'gemini-1.5-flash-002': 'Gemini 1.5 Flash Latest (Enhanced version)',
    'gemini-1.5-pro': 'Gemini 1.5 Pro (Advanced, 2M context)',
    'gemini-1.5-pro-002': 'Gemini 1.5 Pro Latest (Enhanced version)',
    'gemini-1.0-pro': 'Gemini 1.0 Pro (Legacy, stable)',
  };

  constructor() {
    this.logger = createLogger('Gemini');
  }

  async initialize(config: LLMProviderConfig): Promise<void> {
    const customConfig = config.customConfig as Record<string, string | number> | undefined;

    // Get API key from config or environment
    this.apiKey =
      config.apiKey || (customConfig?.apiKey as string) || process.env.GEMINI_API_KEY || '';

    if (!this.apiKey) {
      throw new Error(
        'Gemini API key not provided. Set GEMINI_API_KEY in .env or provide in config. ' +
          'Get a free API key at https://makersuite.google.com/app/apikey',
      );
    }

    // Configure model
    if (customConfig?.model) {
      const modelName = String(customConfig.model);
      if (this.availableModels[modelName as GeminiModelKey]) {
        this.model = modelName;
      } else {
        this.logger.warn('Unknown Gemini model, using default', {
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
      this.maxTokens = Math.max(1, Math.min(32768, Number(customConfig.maxTokens)));
    }

    // Configure rate limiting
    const rpmLimit = customConfig?.rpmLimit
      ? Math.max(1, Math.min(60, Number(customConfig.rpmLimit)))
      : 15;
    const minDelayMs = customConfig?.requestDelayMs
      ? Math.max(500, Number(customConfig.requestDelayMs))
      : 1000;

    // Initialize rate limiter (Gemini free tier: 15 requests/minute)
    this.rateLimiter = new RateLimiter(
      {
        minDelayMs,
        requestsPerMinute: rpmLimit,
        maxRetries: 3,
        baseBackoffMs: 60000,
      },
      'Gemini',
    );

    // Initialize HTTP client
    this.client = axios.create({
      baseURL: this.baseUrl,
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
    // Build the conversation
    const contents: GeminiMessage[] = [];

    // Gemini doesn't have a separate system role, so we combine system + user prompts
    const combinedPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;

    contents.push({
      role: 'user',
      parts: [{ text: combinedPrompt }],
    });

    const request: GeminiRequest = {
      contents,
      generationConfig: {
        temperature: this.temperature,
        maxOutputTokens: this.maxTokens,
        topP: 0.95,
        topK: 40,
      },
      // Safety settings - set to minimum blocking
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
      ],
    };

    try {
      const response = await withRateLimit(this.rateLimiter, () =>
        this.client.post<GeminiResponse>(
          `/models/${this.model}:generateContent?key=${this.apiKey}`,
          request,
        ),
      );

      if (response.data.candidates && response.data.candidates.length > 0) {
        const content = response.data.candidates[0].content.parts[0].text;

        // Log usage statistics
        if (response.data.usageMetadata) {
          const usage = response.data.usageMetadata;
          this.logger.debug('Completion successful', {
            totalTokens: usage.totalTokenCount,
            promptTokens: usage.promptTokenCount,
            completionTokens: usage.candidatesTokenCount,
          });
        }

        return content;
      }

      throw new Error('No completion generated');
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 401 || error.response?.status === 403) {
          throw new Error('Invalid Gemini API key. Please check your configuration.');
        }
        if (error.response?.data?.error) {
          throw new Error(`Gemini API error: ${error.response.data.error.message}`);
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
    // Gemini doesn't have native JSON mode, so we need to be explicit
    const enhancedSystemPrompt = `${systemPrompt || ''}
You must respond with valid JSON that matches this schema:
${JSON.stringify(schema, null, 2)}

IMPORTANT: Your response must be ONLY valid JSON, with no markdown code blocks, no explanatory text before or after, just the raw JSON object.`;

    const enhancedPrompt = `${prompt}

Remember to respond ONLY with valid JSON that matches the provided schema, no additional text or formatting.`;

    const response = await this.generateCompletion(enhancedPrompt, enhancedSystemPrompt);

    try {
      // Clean up response - remove markdown code blocks if present
      let cleanedResponse = response.trim();

      // Remove markdown code blocks
      cleanedResponse = cleanedResponse.replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
      cleanedResponse = cleanedResponse.replace(/^```\s*/i, '').replace(/\s*```$/i, '');

      // Try to parse the JSON response
      return JSON.parse(cleanedResponse) as T;
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
          // Try to find and parse JSON array
          const arrayMatch = response.match(/\[[\s\S]*\]/);
          if (arrayMatch) {
            try {
              return JSON.parse(arrayMatch[0]) as T;
            } catch {
              throw new Error('Failed to parse JSON from Gemini response');
            }
          }
        }
      }

      throw new Error('Gemini did not return valid JSON');
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      const response = await this.client.get(`/models?key=${this.apiKey}`, {
        timeout: 5000,
      });

      return response.status === 200 && response.data.models?.length > 0;
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

export const GeminiLLMProviderPlugin: LLMProviderPlugin = {
  create: (_config: LLMProviderConfig) => {
    const provider = new GeminiLLMProvider();
    return provider;
  },
};
