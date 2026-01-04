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
  private lastRequestTime = Date.now();
  private requestTimes: number[] = []; // Track request times for sliding window
  private rpmLimit = 25; // Free tier allows ~30 RPM, use 25 to stay safe
  private requestDelayMs = 2500; // Minimum 2.5 seconds between requests

  // Dynamic rate limit tracking from headers
  private rateLimitInfo = {
    requestsLimit: 14400, // Requests per day
    requestsRemaining: 14400,
    requestsReset: Date.now() + 86400000, // 24 hours
    tokensLimit: 18000, // Tokens per minute
    tokensRemaining: 18000,
    tokensReset: Date.now() + 60000, // 1 minute
    retryAfter: 0,
  };

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

    // Configure rate limiting
    if (customConfig?.rpmLimit !== undefined) {
      this.rpmLimit = Math.max(1, Math.min(30, Number(customConfig.rpmLimit)));
    }

    if (customConfig?.requestDelayMs !== undefined) {
      this.requestDelayMs = Math.max(1000, Number(customConfig.requestDelayMs));
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

      // Update rate limit info from response headers
      this.updateRateLimitInfo(response.headers);

      if (response.data.choices && response.data.choices.length > 0) {
        const content = response.data.choices[0].message.content;

        // Log performance metrics and usage
        if (response.data.usage) {
          const tokensPerSecond =
            response.data.usage.completion_tokens / response.data.usage.completion_time;

          // Log basic performance
          console.log(
            `✅ Groq completion: ${response.data.usage.total_tokens} tokens in ${response.data.usage.total_time.toFixed(2)}s ` +
              `(${tokensPerSecond.toFixed(0)} tokens/sec)`,
          );

          // Log detailed usage stats every 10 requests
          if (this.requestTimes.length % 10 === 0) {
            console.log(
              `📊 Groq usage stats:\n` +
                `  • Daily: ${this.rateLimitInfo.requestsRemaining}/${this.rateLimitInfo.requestsLimit} requests remaining\n` +
                `  • Per minute: ${this.rateLimitInfo.tokensRemaining}/${this.rateLimitInfo.tokensLimit} tokens remaining\n` +
                `  • Current request: ${response.data.usage.prompt_tokens} prompt + ${response.data.usage.completion_tokens} completion tokens`,
            );
          }
        }

        return content;
      }

      throw new Error('No completion generated');
    } catch (error) {
      if (axios.isAxiosError(error)) {
        // Always try to update rate limit info from error response headers
        if (error.response?.headers) {
          this.updateRateLimitInfo(error.response.headers);
        }

        if (error.response?.status === 429) {
          // Prevent infinite retry loops
          if (retryCount >= 3) {
            console.error('❌ Max retries reached for Groq API. Giving up.');
            throw new Error('Groq API rate limit exceeded after multiple retries.');
          }

          // Get retry-after from headers if available
          const retryAfter = error.response.headers['retry-after'];
          const waitTime = retryAfter ? parseInt(String(retryAfter)) * 1000 : 60000;

          // Determine which limit was hit based on headers and retry-after time
          let limitType = 'rate limit';
          let limitDetails = '';
          const remainingRequests = error.response.headers['x-ratelimit-remaining-requests'];
          const remainingTokens = error.response.headers['x-ratelimit-remaining-tokens'];
          const limitRequests = error.response.headers['x-ratelimit-limit-requests'];
          const limitTokens = error.response.headers['x-ratelimit-limit-tokens'];
          const resetRequests = error.response.headers['x-ratelimit-reset-requests'];
          const resetTokens = error.response.headers['x-ratelimit-reset-tokens'];

          // Parse remaining values (they might be strings or numbers)
          const reqRemaining =
            remainingRequests !== undefined ? parseInt(String(remainingRequests)) : null;
          const tokRemaining =
            remainingTokens !== undefined ? parseInt(String(remainingTokens)) : null;

          // Determine which limit was hit based on what's at zero or based on wait time
          if (reqRemaining === 0) {
            // Daily request limit hit
            const totalLimit = limitRequests
              ? parseInt(String(limitRequests))
              : this.rateLimitInfo.requestsLimit;
            const used = totalLimit - reqRemaining;
            limitType = `daily request limit`;
            limitDetails = `\n  📊 Daily requests: ${used}/${totalLimit} used (0 remaining)`;
            limitDetails += `\n  ⏰ Resets: ${resetRequests || 'in 24 hours'}`;
            limitDetails += `\n  💡 Reason: You've exhausted all ${totalLimit} daily API requests. This is a hard daily limit.`;
            limitDetails += `\n  💰 Solution: Wait for reset or upgrade to a paid plan for more requests.`;
          } else if (tokRemaining === 0) {
            // Token per minute limit hit
            const totalLimit = limitTokens
              ? parseInt(String(limitTokens))
              : this.rateLimitInfo.tokensLimit;
            limitType = `token per minute limit`;
            limitDetails = `\n  📊 Tokens/minute: ${totalLimit}/${totalLimit} used (0 remaining)`;
            limitDetails += `\n  ⏰ Resets: ${resetTokens || 'in ~60 seconds'}`;
            limitDetails += `\n  💡 Reason: Too many tokens processed in the last minute. Your prompts/responses are too large.`;
            limitDetails += `\n  💰 Solution: Use shorter prompts, wait for reset, or spread requests over time.`;
          } else if (waitTime < 10000) {
            // Short wait time usually means token limit (resets every minute)
            limitType = `token burst limit`;
            limitDetails = `\n  📊 Tokens remaining: ${tokRemaining !== null ? tokRemaining : 'unknown'}`;
            limitDetails += `\n  📊 Token limit: ${limitTokens || this.rateLimitInfo.tokensLimit} per minute`;
            limitDetails += `\n  ⏰ Resets: in ${waitTime / 1000} seconds`;
            limitDetails += `\n  💡 Reason: Burst of token usage detected. Token limits reset every minute.`;
            limitDetails += `\n  💰 Solution: This is a short wait - token limits reset quickly.`;
          } else if (waitTime > 60000) {
            // Long wait time usually means request limit
            limitType = `request rate limit`;
            limitDetails = `\n  📊 Requests remaining: ${reqRemaining !== null ? reqRemaining : 'unknown'}`;
            limitDetails += `\n  📊 Daily limit: ${limitRequests || this.rateLimitInfo.requestsLimit}`;
            limitDetails += `\n  ⏰ Wait time: ${Math.round(waitTime / 60000)} minutes`;
            limitDetails += `\n  💡 Reason: Too many requests in a short period or approaching daily limit.`;
            limitDetails += `\n  💰 Solution: Implement better request batching or upgrade your plan.`;
          } else {
            // Medium wait time - could be requests per minute limit
            limitType = `request burst limit`;
            limitDetails = `\n  📊 Requests remaining: ${reqRemaining !== null ? reqRemaining : 'unknown'} today`;
            limitDetails += `\n  📊 Tokens remaining: ${tokRemaining !== null ? tokRemaining : 'unknown'} this minute`;
            limitDetails += `\n  ⏰ Wait time: ${waitTime / 1000} seconds`;
            limitDetails += `\n  💡 Reason: Too many requests in rapid succession. Groq limits bursts to prevent abuse.`;
            limitDetails += `\n  💰 Solution: Add delays between requests (currently ${this.requestDelayMs / 1000}s).`;
          }

          // Add request history context
          const requestsInLastMinute = this.requestTimes.length;
          limitDetails += `\n  📈 Recent activity: ${requestsInLastMinute} requests in last minute`;
          limitDetails += `\n  ⏳ Configured delays: ${this.requestDelayMs / 1000}s between requests`;

          console.warn(
            `🚫 Groq ${limitType} exceeded!${limitDetails}\n` +
              `⏸️  Action: Waiting ${waitTime / 1000}s before retry ${retryCount + 1}/3...`,
          );

          // Actually wait before retrying
          await new Promise((resolve) => setTimeout(resolve, waitTime));

          // Store the retry-after time for future requests
          this.rateLimitInfo.retryAfter = Date.now() + waitTime;

          // Retry the request after waiting
          console.log(`🔄 Retrying request after rate limit wait (attempt ${retryCount + 2}/3)...`);
          return this.generateCompletion(prompt, systemPrompt, retryCount + 1);
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

  private updateRateLimitInfo(headers: Record<string, unknown>): void {
    // Parse rate limit headers from Groq API
    if (headers['retry-after']) {
      this.rateLimitInfo.retryAfter = parseInt(String(headers['retry-after'])) * 1000;
    }

    if (headers['x-ratelimit-limit-requests']) {
      this.rateLimitInfo.requestsLimit = parseInt(String(headers['x-ratelimit-limit-requests']));
    }

    if (headers['x-ratelimit-limit-tokens']) {
      this.rateLimitInfo.tokensLimit = parseInt(String(headers['x-ratelimit-limit-tokens']));
    }

    if (headers['x-ratelimit-remaining-requests']) {
      this.rateLimitInfo.requestsRemaining = parseInt(
        String(headers['x-ratelimit-remaining-requests']),
      );
    }

    if (headers['x-ratelimit-remaining-tokens']) {
      this.rateLimitInfo.tokensRemaining = parseInt(
        String(headers['x-ratelimit-remaining-tokens']),
      );
    }

    if (headers['x-ratelimit-reset-requests']) {
      // Parse time format like "2m59.56s" or "24h"
      const resetStr = String(headers['x-ratelimit-reset-requests']);
      this.rateLimitInfo.requestsReset = Date.now() + this.parseTimeString(resetStr);
    }

    if (headers['x-ratelimit-reset-tokens']) {
      // Parse time format like "7.66s"
      const resetStr = String(headers['x-ratelimit-reset-tokens']);
      this.rateLimitInfo.tokensReset = Date.now() + this.parseTimeString(resetStr);
    }
  }

  private parseTimeString(timeStr: string): number {
    // Parse Groq's time format: "2m59.56s", "7.66s", "24h", etc.
    let totalMs = 0;

    // Match hours
    const hoursMatch = timeStr.match(/(\d+)h/);
    if (hoursMatch) {
      totalMs += parseInt(hoursMatch[1]) * 3600000;
    }

    // Match minutes
    const minutesMatch = timeStr.match(/(\d+)m/);
    if (minutesMatch) {
      totalMs += parseInt(minutesMatch[1]) * 60000;
    }

    // Match seconds (including decimals)
    const secondsMatch = timeStr.match(/([\d.]+)s/);
    if (secondsMatch) {
      totalMs += parseFloat(secondsMatch[1]) * 1000;
    }

    return totalMs;
  }

  private async enforceRateLimit(): Promise<void> {
    const now = Date.now();

    // First check if we have a retry-after header from a previous 429
    if (this.rateLimitInfo.retryAfter > 0 && now < this.rateLimitInfo.retryAfter) {
      const waitTime = this.rateLimitInfo.retryAfter - now;
      console.log(`⏱️ Groq API retry-after: waiting ${Math.ceil(waitTime / 1000)}s...`);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      this.rateLimitInfo.retryAfter = 0; // Clear after waiting
    }

    // Check if we're running low on daily requests
    if (this.rateLimitInfo.requestsRemaining < 100) {
      console.warn(
        `⚠️ Groq daily requests low: ${this.rateLimitInfo.requestsRemaining}/${this.rateLimitInfo.requestsLimit} remaining`,
      );

      // If very low, add extra delay
      if (this.rateLimitInfo.requestsRemaining < 50) {
        const extraDelay = 30000; // 30 second delay when very low
        console.log(`⏳ Low on daily requests, adding ${extraDelay / 1000}s delay...`);
        await new Promise((resolve) => setTimeout(resolve, extraDelay));
      }
    }

    // Check if we're running low on tokens per minute
    if (this.rateLimitInfo.tokensRemaining < 1000 && now < this.rateLimitInfo.tokensReset) {
      const waitTime = this.rateLimitInfo.tokensReset - now;
      console.log(
        `⏱️ Groq token limit: ${this.rateLimitInfo.tokensRemaining}/${this.rateLimitInfo.tokensLimit} tokens remaining. ` +
          `Waiting ${Math.ceil(waitTime / 1000)}s for reset...`,
      );
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    // Clean up request times older than 1 minute
    this.requestTimes = this.requestTimes.filter((time) => now - time < 60000);

    // Check if we're at the rate limit
    if (this.requestTimes.length >= this.rpmLimit) {
      // Find the oldest request in the window
      const oldestRequest = Math.min(...this.requestTimes);
      const waitTime = 60000 - (now - oldestRequest) + 1000; // Add 1 second buffer

      if (waitTime > 0) {
        console.log(
          `⏱️ Groq rate limit: ${this.requestTimes.length}/${this.rpmLimit} requests in last minute. ` +
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
      console.log(`⏳ Groq request throttling: waiting ${Math.ceil(delayTime / 1000)}s...`);
      await new Promise((resolve) => setTimeout(resolve, delayTime));
    }

    // Record this request
    const requestTime = Date.now();
    this.requestTimes.push(requestTime);
    this.lastRequestTime = requestTime;

    // Log current rate
    if (this.requestTimes.length % 5 === 0) {
      console.log(
        `📊 Groq API usage: ${this.requestTimes.length}/${this.rpmLimit} requests/min | ` +
          `${this.rateLimitInfo.requestsRemaining}/${this.rateLimitInfo.requestsLimit} requests/day | ` +
          `${this.rateLimitInfo.tokensRemaining}/${this.rateLimitInfo.tokensLimit} tokens/min`,
      );
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
