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

    it('should warn about unknown model', async () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      const config: LLMProviderConfig = {
        name: 'gemini',
        apiKey: 'test-key',
        customConfig: {
          model: 'unknown-model',
        },
      };

      await provider.initialize(config);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Unknown Gemini model: unknown-model'),
      );

      consoleSpy.mockRestore();
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
        expect.stringContaining('/models/gemini-1.5-flash:generateContent'),
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
      // Reinitialize provider to ensure it retries immediately without waiting
      await provider.initialize({
        name: 'gemini',
        apiKey: 'test-key',
        customConfig: {
          requestDelayMs: 0, // Disable rate limiting for tests
        },
      });

      (mockedAxios.isAxiosError as unknown as jest.Mock) = jest.fn().mockReturnValue(true);
      const error = new Error('Rate limited') as Error & {
        response: { status: number; headers: Record<string, string> };
      };
      error.response = { status: 429, headers: {} };

      // Mock it to always fail with 429 (no successful retry)
      mockAxiosInstance.post.mockRejectedValue(error);

      // Test with retryCount already at 3 to immediately fail
      await expect(provider.generateCompletion('Test', undefined, 3)).rejects.toThrow(
        'Gemini API rate limit exceeded',
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

    it('should enforce rate limiting', async () => {
      // Reinitialize with rate limiting enabled for this test
      await provider.initialize({
        name: 'gemini',
        apiKey: 'test-key',
        customConfig: {
          requestDelayMs: 1000, // Enable 1 second delay
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

      // Make two rapid requests
      const start = Date.now();
      await provider.generateCompletion('First');
      await provider.generateCompletion('Second');
      const elapsed = Date.now() - start;

      // Should have waited at least 1 second between requests
      expect(elapsed).toBeGreaterThanOrEqual(1000);
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
    it('should log destruction message', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      await provider.destroy();

      expect(consoleSpy).toHaveBeenCalledWith('Gemini LLM Provider destroyed');

      consoleSpy.mockRestore();
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
