import axios, { AxiosInstance } from 'axios';
import { LLMProvider, LLMProviderConfig, LLMProviderPlugin } from '../../../types';

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
  private model: string = 'gemini-1.5-flash'; // Default to Gemini 1.5 Flash (best free tier)
  private temperature: number = 0.7;
  private maxTokens: number = 8192;
  private lastRequestTime = Date.now();
  private requestTimes: number[] = []; // Track request times for sliding window
  private rpmLimit = 60; // Free tier: 60 requests per minute
  private requestDelayMs = 1000; // Minimum 1 second between requests

  // Available Gemini models (as of 2024)
  private readonly availableModels: Record<GeminiModelKey, string> = {
    'gemini-1.5-flash': 'Gemini 1.5 Flash (Fast, 1M context, best for free tier)',
    'gemini-1.5-flash-002': 'Gemini 1.5 Flash Latest (Enhanced version)',
    'gemini-1.5-pro': 'Gemini 1.5 Pro (Advanced, 2M context)',
    'gemini-1.5-pro-002': 'Gemini 1.5 Pro Latest (Enhanced version)',
    'gemini-1.0-pro': 'Gemini 1.0 Pro (Legacy, stable)',
  };

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
        console.warn(`Unknown Gemini model: ${modelName}, using default: ${this.model}`);
        console.log('Available models:', Object.keys(this.availableModels).join(', '));
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
    if (customConfig?.rpmLimit !== undefined) {
      this.rpmLimit = Math.max(1, Math.min(60, Number(customConfig.rpmLimit)));
    }

    if (customConfig?.requestDelayMs !== undefined) {
      this.requestDelayMs = Math.max(500, Number(customConfig.requestDelayMs));
    }

    // Initialize HTTP client
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000, // 30 second timeout
    });

    console.log(`Gemini LLM Provider initialized with model: ${this.model}`);
    console.log(`Model description: ${this.availableModels[this.model as GeminiModelKey]}`);
    console.log(`Temperature: ${this.temperature}, Max Tokens: ${this.maxTokens}`);
    console.log(
      `Rate Limiting: ${this.rpmLimit} requests/minute, ${this.requestDelayMs}ms min delay`,
    );
  }

  async generateCompletion(
    prompt: string,
    systemPrompt?: string,
    retryCount: number = 0,
  ): Promise<string> {
    try {
      // Rate limiting (Gemini free tier: 60 requests per minute)
      await this.enforceRateLimit();

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

      const response = await this.client.post<GeminiResponse>(
        `/models/${this.model}:generateContent?key=${this.apiKey}`,
        request,
      );

      if (response.data.candidates && response.data.candidates.length > 0) {
        const content = response.data.candidates[0].content.parts[0].text;

        // Log usage statistics
        if (response.data.usageMetadata) {
          const usage = response.data.usageMetadata;
          console.log(
            `✅ Gemini completion: ${usage.totalTokenCount} tokens ` +
              `(${usage.promptTokenCount} prompt + ${usage.candidatesTokenCount} completion)`,
          );

          // Log detailed usage stats every 10 requests
          if (this.requestTimes.length % 10 === 0) {
            console.log(
              `📊 Gemini usage stats:\n` +
                `  • Requests: ${this.requestTimes.length} in last minute\n` +
                `  • Rate limit: ${this.rpmLimit} requests/minute\n` +
                `  • Current model: ${this.model}`,
            );
          }
        }

        return content;
      }

      throw new Error('No completion generated');
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 429) {
          // Prevent infinite retry loops
          if (retryCount >= 3) {
            console.error('❌ Max retries reached for Gemini API. Giving up.');
            throw new Error('Gemini API rate limit exceeded after multiple retries.');
          }

          // Get retry-after from headers or default to 60 seconds
          const retryAfter = error.response?.headers?.['retry-after'];
          // In test environment or when requestDelayMs is 0, don't wait
          const waitTime =
            this.requestDelayMs === 0
              ? 0
              : retryAfter
                ? parseInt(String(retryAfter)) * 1000
                : 60000;

          if (waitTime > 0) {
            console.warn(
              `🚫 Gemini rate limit exceeded!\n` +
                `⏸️  Action: Waiting ${waitTime / 1000}s before retry ${retryCount + 1}/3...`,
            );

            // Wait before retrying
            await new Promise((resolve) => setTimeout(resolve, waitTime));
          }

          // Retry the request
          console.log(`🔄 Retrying request after rate limit wait (attempt ${retryCount + 2}/3)...`);
          return this.generateCompletion(prompt, systemPrompt, retryCount + 1);
        }
        if (error.response?.status === 401 || error.response?.status === 403) {
          throw new Error('Invalid Gemini API key. Please check your configuration.');
        }
        if (error.response?.data?.error) {
          throw new Error(`Gemini API error: ${error.response.data.error.message}`);
        }
      }
      console.error('Error generating completion with Gemini:', error);
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
      console.error('Failed to parse Gemini JSON response:', error);
      console.error('Response was:', response);

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

  private async enforceRateLimit(): Promise<void> {
    const now = Date.now();

    // Clean up request times older than 1 minute
    this.requestTimes = this.requestTimes.filter((time) => now - time < 60000);

    // Check if we're at the rate limit
    if (this.requestTimes.length >= this.rpmLimit) {
      // Find the oldest request in the window
      const oldestRequest = Math.min(...this.requestTimes);
      const waitTime = 60000 - (now - oldestRequest) + 1000; // Add 1 second buffer

      if (waitTime > 0) {
        console.log(
          `⏱️ Gemini rate limit: ${this.requestTimes.length}/${this.rpmLimit} requests in last minute. ` +
            `Waiting ${Math.ceil(waitTime / 1000)}s...`,
        );
        await new Promise((resolve) => setTimeout(resolve, waitTime));

        // Clean up again after waiting
        const afterWait = Date.now();
        this.requestTimes = this.requestTimes.filter((time) => afterWait - time < 60000);
      }
    }

    // Enforce minimum delay between requests
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.requestDelayMs) {
      const delayTime = this.requestDelayMs - timeSinceLastRequest;
      console.log(`⏳ Gemini request throttling: waiting ${Math.ceil(delayTime / 1000)}s...`);
      await new Promise((resolve) => setTimeout(resolve, delayTime));
    }

    // Record this request
    const requestTime = Date.now();
    this.requestTimes.push(requestTime);
    this.lastRequestTime = requestTime;

    // Log current rate
    if (this.requestTimes.length % 5 === 0) {
      console.log(`📊 Gemini API usage: ${this.requestTimes.length}/${this.rpmLimit} requests/min`);
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      // Simple health check - list available models
      const response = await this.client.get(`/models?key=${this.apiKey}`, {
        timeout: 5000,
      });

      return response.status === 200 && response.data.models?.length > 0;
    } catch (error) {
      console.error('Gemini health check failed:', error);
      return false;
    }
  }

  async destroy(): Promise<void> {
    console.log('Gemini LLM Provider destroyed');
  }
}

export const GeminiLLMProviderPlugin: LLMProviderPlugin = {
  create: (_config: LLMProviderConfig) => {
    const provider = new GeminiLLMProvider();
    return provider;
  },
};
