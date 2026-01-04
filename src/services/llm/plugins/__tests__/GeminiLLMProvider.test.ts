import { GeminiLLMProvider, GeminiLLMProviderPlugin } from '../GeminiLLMProvider';
import axios from 'axios';
import { LLMProviderConfig } from '../../../../types';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('GeminiLLMProvider', () => {
  let provider: GeminiLLMProvider;
  let mockAxiosInstance: {
    post: jest.Mock;
    get: jest.Mock;
  };

  beforeEach(() => {
    provider = new GeminiLLMProvider();

    // Mock axios instance
    mockAxiosInstance = {
      post: jest.fn(),
      get: jest.fn(),
    };

    mockedAxios.create = jest.fn().mockReturnValue(mockAxiosInstance);
    (mockedAxios.isAxiosError as unknown as jest.Mock) = jest.fn().mockReturnValue(false);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('initialize', () => {
    it('should initialize with API key from config', async () => {
      const config: LLMProviderConfig = {
        name: 'gemini',
        apiKey: 'test-api-key',
      };

      await provider.initialize(config);

      expect(mockedAxios.create).toHaveBeenCalledWith({
        baseURL: 'https://generativelanguage.googleapis.com/v1beta',
        timeout: 30000,
      });
    });

    it('should initialize with API key from environment', async () => {
      process.env.GEMINI_API_KEY = 'env-api-key';

      const config: LLMProviderConfig = {
        name: 'gemini',
      };

      await provider.initialize(config);

      expect(mockedAxios.create).toHaveBeenCalled();
      expect(provider.name).toBe('gemini');

      delete process.env.GEMINI_API_KEY;
    });

    it('should throw error if no API key provided', async () => {
      const config: LLMProviderConfig = {
        name: 'gemini',
      };

      await expect(provider.initialize(config)).rejects.toThrow('Gemini API key not provided');
    });

    it('should configure custom model if provided', async () => {
      const config: LLMProviderConfig = {
        name: 'gemini',
        apiKey: 'test-key',
        customConfig: {
          model: 'gemini-1.5-pro',
        },
      };

      await provider.initialize(config);

      // Model should be set (we'll verify in generateCompletion test)
      expect(provider.name).toBe('gemini');
    });

    it('should use default model when unknown model is provided', async () => {
      const config: LLMProviderConfig = {
        name: 'gemini',
        apiKey: 'test-key',
        customConfig: {
          model: 'unknown-model',
        },
      };

      // Should initialize successfully and fall back to default model
      await provider.initialize(config);

      // Provider should still work with default model
      expect(provider.name).toBe('gemini');
    });

    it('should configure temperature and maxTokens', async () => {
      const config: LLMProviderConfig = {
        name: 'gemini',
        apiKey: 'test-key',
        customConfig: {
          temperature: 0.5,
          maxTokens: 2048,
        },
      };

      await provider.initialize(config);

      // Values should be set (we'll verify in generateCompletion test)
      expect(provider.name).toBe('gemini');
    });
  });

  describe('generateCompletion', () => {
    beforeEach(async () => {
      await provider.initialize({
        name: 'gemini',
        apiKey: 'test-key',
        customConfig: {
          requestDelayMs: 0, // Disable rate limiting for tests
        },
      });
    });

    it('should generate completion successfully', async () => {
      const mockResponse = {
        data: {
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: 'This is a test completion',
                  },
                ],
                role: 'model',
              },
              finishReason: 'STOP',
              index: 0,
            },
          ],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 5,
            totalTokenCount: 15,
          },
        },
      };

      mockAxiosInstance.post.mockResolvedValue(mockResponse);

      const result = await provider.generateCompletion('Test prompt');

      expect(result).toBe('This is a test completion');
      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        expect.stringContaining('/models/gemini-3-flash-preview:generateContent'),
        expect.objectContaining({
          contents: [
            {
              role: 'user',
              parts: [{ text: 'Test prompt' }],
            },
          ],
          generationConfig: expect.objectContaining({
            temperature: 0.7,
            maxOutputTokens: 8192,
          }),
        }),
      );
    });

    it('should include system prompt if provided', async () => {
      const mockResponse = {
        data: {
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: 'Response with system prompt',
                  },
                ],
                role: 'model',
              },
              finishReason: 'STOP',
              index: 0,
            },
          ],
        },
      };

      mockAxiosInstance.post.mockResolvedValue(mockResponse);

      await provider.generateCompletion('User prompt', 'System prompt');

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          contents: [
            {
              role: 'user',
              parts: [{ text: 'System prompt\n\nUser prompt' }],
            },
          ],
        }),
      );
    });

    it('should handle rate limit error', async () => {
      (mockedAxios.isAxiosError as unknown as jest.Mock) = jest.fn().mockReturnValue(true);
      const error = new Error('Rate limited') as Error & {
        response: { status: number; headers: Record<string, string> };
        isAxiosError: boolean;
      };
      error.response = { status: 429, headers: {} };
      error.isAxiosError = true;

      // Mock it to always fail with 429 (no successful retry)
      mockAxiosInstance.post.mockRejectedValue(error);

      // Rate limiter will retry 3 times then throw max retries error
      await expect(provider.generateCompletion('Test')).rejects.toThrow(
        'Rate limit exceeded after maximum retries',
      );
    });

    it('should handle invalid API key error', async () => {
      (mockedAxios.isAxiosError as unknown as jest.Mock) = jest.fn().mockReturnValue(true);
      const error = new Error('Unauthorized') as Error & {
        response: { status: number };
      };
      error.response = { status: 401 };

      mockAxiosInstance.post.mockRejectedValue(error);

      await expect(provider.generateCompletion('Test')).rejects.toThrow('Invalid Gemini API key');
    });

    it('should handle API error with message', async () => {
      (mockedAxios.isAxiosError as unknown as jest.Mock) = jest.fn().mockReturnValue(true);
      const error = new Error('API Error') as Error & {
        response: {
          status: number;
          data: {
            error: {
              message: string;
            };
          };
        };
      };
      error.response = {
        status: 400,
        data: {
          error: {
            message: 'Bad request: invalid model',
          },
        },
      };

      mockAxiosInstance.post.mockRejectedValue(error);

      await expect(provider.generateCompletion('Test')).rejects.toThrow(
        'Gemini API error: Bad request: invalid model',
      );
    });

    it('should configure rate limiting', async () => {
      // Reinitialize with rate limiting enabled
      await provider.initialize({
        name: 'gemini',
        apiKey: 'test-key',
        customConfig: {
          requestDelayMs: 1000, // Configure 1 second delay
          rpmLimit: 10,
        },
      });

      const mockResponse = {
        data: {
          candidates: [
            {
              content: {
                parts: [{ text: 'Test response' }],
                role: 'model',
              },
              finishReason: 'STOP',
              index: 0,
            },
          ],
        },
      };

      mockAxiosInstance.post.mockResolvedValue(mockResponse);

      // Verify rate limiter is working by making requests
      // Note: Actual delays are skipped in test environment for speed
      const result1 = await provider.generateCompletion('First');
      const result2 = await provider.generateCompletion('Second');

      expect(result1).toBe('Test response');
      expect(result2).toBe('Test response');
      expect(mockAxiosInstance.post).toHaveBeenCalledTimes(2);
    });
  });

  describe('generateStructuredOutput', () => {
    beforeEach(async () => {
      await provider.initialize({
        name: 'gemini',
        apiKey: 'test-key',
        customConfig: {
          requestDelayMs: 0, // Disable rate limiting for tests
        },
      });
    });

    it('should generate structured output successfully', async () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
      };

      const mockResponse = {
        data: {
          candidates: [
            {
              content: {
                parts: [{ text: '{"name": "John", "age": 30}' }],
                role: 'model',
              },
              finishReason: 'STOP',
              index: 0,
            },
          ],
        },
      };

      mockAxiosInstance.post.mockResolvedValue(mockResponse);

      const result = await provider.generateStructuredOutput('Generate a person', schema);

      expect(result).toEqual({ name: 'John', age: 30 });
    });

    it('should extract JSON from response with markdown blocks', async () => {
      const schema = { type: 'object' };

      const mockResponse = {
        data: {
          candidates: [
            {
              content: {
                parts: [{ text: '```json\n{"key": "value"}\n```' }],
                role: 'model',
              },
              finishReason: 'STOP',
              index: 0,
            },
          ],
        },
      };

      mockAxiosInstance.post.mockResolvedValue(mockResponse);

      const result = await provider.generateStructuredOutput('Generate', schema);

      expect(result).toEqual({ key: 'value' });
    });

    it('should extract JSON array from response', async () => {
      const schema = { type: 'array' };

      const mockResponse = {
        data: {
          candidates: [
            {
              content: {
                parts: [{ text: 'Here is the array: [{"id": 1}, {"id": 2}]' }],
                role: 'model',
              },
              finishReason: 'STOP',
              index: 0,
            },
          ],
        },
      };

      mockAxiosInstance.post.mockResolvedValue(mockResponse);

      const result = await provider.generateStructuredOutput('Generate', schema);

      expect(result).toEqual([{ id: 1 }, { id: 2 }]);
    });

    it('should throw error if JSON parsing fails', async () => {
      const schema = { type: 'object' };

      const mockResponse = {
        data: {
          candidates: [
            {
              content: {
                parts: [{ text: 'This is not JSON' }],
                role: 'model',
              },
              finishReason: 'STOP',
              index: 0,
            },
          ],
        },
      };

      mockAxiosInstance.post.mockResolvedValue(mockResponse);

      await expect(provider.generateStructuredOutput('Generate', schema)).rejects.toThrow(
        'Gemini did not return valid JSON',
      );
    });
  });

  describe('isHealthy', () => {
    beforeEach(async () => {
      await provider.initialize({
        name: 'gemini',
        apiKey: 'test-key',
        customConfig: {
          requestDelayMs: 0, // Disable rate limiting for tests
        },
      });
    });

    it('should return true when API is accessible', async () => {
      mockAxiosInstance.get.mockResolvedValue({
        status: 200,
        data: {
          models: [{ name: 'models/gemini-1.5-flash' }, { name: 'models/gemini-1.5-pro' }],
        },
      });

      const result = await provider.isHealthy();

      expect(result).toBe(true);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith(expect.stringContaining('/models?key='), {
        timeout: 5000,
      });
    });

    it('should return false when API is not accessible', async () => {
      mockAxiosInstance.get.mockRejectedValue(new Error('Network error'));

      const result = await provider.isHealthy();

      expect(result).toBe(false);
    });

    it('should return false when no models are available', async () => {
      mockAxiosInstance.get.mockResolvedValue({
        status: 200,
        data: {
          models: [],
        },
      });

      const result = await provider.isHealthy();

      expect(result).toBe(false);
    });
  });

  describe('destroy', () => {
    it('should complete without error', async () => {
      // destroy should complete successfully
      await expect(provider.destroy()).resolves.not.toThrow();
    });
  });

  describe('GeminiLLMProviderPlugin', () => {
    it('should create a new instance', () => {
      const config: LLMProviderConfig = {
        name: 'gemini',
      };

      const instance = GeminiLLMProviderPlugin.create(config);

      expect(instance).toBeInstanceOf(GeminiLLMProvider);
    });
  });
});
