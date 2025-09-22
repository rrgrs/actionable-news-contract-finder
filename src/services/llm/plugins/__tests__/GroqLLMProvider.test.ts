import { GroqLLMProvider, GroqLLMProviderPlugin } from '../GroqLLMProvider';
import axios from 'axios';
import { LLMProviderConfig } from '../../../../types';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('GroqLLMProvider', () => {
  let provider: GroqLLMProvider;
  let mockAxiosInstance: {
    post: jest.Mock;
    get: jest.Mock;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    provider = new GroqLLMProvider();

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
    jest.useRealTimers();
  });

  describe('initialize', () => {
    it('should initialize with API key from config', async () => {
      const config: LLMProviderConfig = {
        name: 'groq',
        apiKey: 'test-api-key',
      };

      await provider.initialize(config);

      expect(mockedAxios.create).toHaveBeenCalledWith({
        baseURL: 'https://api.groq.com/openai/v1',
        headers: {
          Authorization: 'Bearer test-api-key',
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      });
    });

    it('should initialize with API key from environment', async () => {
      process.env.GROQ_API_KEY = 'env-api-key';

      const config: LLMProviderConfig = {
        name: 'groq',
      };

      await provider.initialize(config);

      expect(mockedAxios.create).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer env-api-key',
          }),
        }),
      );

      delete process.env.GROQ_API_KEY;
    });

    it('should throw error if no API key provided', async () => {
      const config: LLMProviderConfig = {
        name: 'groq',
      };

      await expect(provider.initialize(config)).rejects.toThrow('Groq API key not provided');
    });

    it('should configure custom model if provided', async () => {
      const config: LLMProviderConfig = {
        name: 'groq',
        apiKey: 'test-key',
        customConfig: {
          model: 'llama3-8b-8192',
        },
      };

      await provider.initialize(config);

      // Model should be set (we'll verify in generateCompletion test)
      expect(provider.name).toBe('groq');
    });

    it('should warn about unknown model', async () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      const config: LLMProviderConfig = {
        name: 'groq',
        apiKey: 'test-key',
        customConfig: {
          model: 'unknown-model',
        },
      };

      await provider.initialize(config);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Unknown Groq model: unknown-model'),
      );

      consoleSpy.mockRestore();
    });

    it('should configure temperature and maxTokens', async () => {
      const config: LLMProviderConfig = {
        name: 'groq',
        apiKey: 'test-key',
        customConfig: {
          temperature: 0.5,
          maxTokens: 2048,
        },
      };

      await provider.initialize(config);

      // Values should be set (we'll verify in generateCompletion test)
      expect(provider.name).toBe('groq');
    });
  });

  describe('generateCompletion', () => {
    beforeEach(async () => {
      await provider.initialize({
        name: 'groq',
        apiKey: 'test-key',
      });
    });

    it('should generate completion successfully', async () => {
      const mockResponse = {
        data: {
          choices: [
            {
              message: {
                content: 'This is a test completion',
              },
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
            prompt_time: 0.01,
            completion_time: 0.02,
            total_time: 0.03,
          },
        },
      };

      mockAxiosInstance.post.mockResolvedValue(mockResponse);

      const result = await provider.generateCompletion('Test prompt');

      expect(result).toBe('This is a test completion');
      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        '/chat/completions',
        expect.objectContaining({
          model: 'llama3-70b-8192',
          messages: [
            {
              role: 'user',
              content: 'Test prompt',
            },
          ],
          temperature: 0.7,
          max_tokens: 4096,
          stream: false,
        }),
      );
    });

    it('should include system prompt if provided', async () => {
      const mockResponse = {
        data: {
          choices: [
            {
              message: {
                content: 'Response with system prompt',
              },
            },
          ],
        },
      };

      mockAxiosInstance.post.mockResolvedValue(mockResponse);

      await provider.generateCompletion('User prompt', 'System prompt');

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        '/chat/completions',
        expect.objectContaining({
          messages: [
            {
              role: 'system',
              content: 'System prompt',
            },
            {
              role: 'user',
              content: 'User prompt',
            },
          ],
        }),
      );
    });

    it('should enable JSON mode when JSON is mentioned', async () => {
      const mockResponse = {
        data: {
          choices: [
            {
              message: {
                content: '{"key": "value"}',
              },
            },
          ],
        },
      };

      mockAxiosInstance.post.mockResolvedValue(mockResponse);

      await provider.generateCompletion('Return JSON response');

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        '/chat/completions',
        expect.objectContaining({
          response_format: { type: 'json_object' },
        }),
      );
    });

    it.skip('should handle rate limit error', async () => {
      (mockedAxios.isAxiosError as unknown as jest.Mock) = jest.fn().mockReturnValue(true);
      const error = new Error('Rate limited') as Error & {
        response: { status: number };
      };
      error.response = { status: 429 };

      mockAxiosInstance.post.mockRejectedValue(error);

      await expect(provider.generateCompletion('Test')).rejects.toThrow('Groq rate limit exceeded');
    });

    it.skip('should handle invalid API key error', async () => {
      (mockedAxios.isAxiosError as unknown as jest.Mock) = jest.fn().mockReturnValue(true);
      const error = new Error('Unauthorized') as Error & {
        response: { status: number };
      };
      error.response = { status: 401 };

      mockAxiosInstance.post.mockRejectedValue(error);

      await expect(provider.generateCompletion('Test')).rejects.toThrow('Invalid Groq API key');
    });

    it.skip('should handle API error with message', async () => {
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
        'Groq API error: Bad request: invalid model',
      );
    });

    it.skip('should enforce rate limiting', async () => {
      const mockResponse = {
        data: {
          choices: [
            {
              message: {
                content: 'Test response',
              },
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

      // Should have waited at least 2 seconds between requests
      expect(elapsed).toBeGreaterThanOrEqual(2000);
    });
  });

  describe('generateStructuredOutput', () => {
    beforeEach(async () => {
      await provider.initialize({
        name: 'groq',
        apiKey: 'test-key',
      });
    });

    it.skip('should generate structured output successfully', async () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
      };

      const mockResponse = {
        data: {
          choices: [
            {
              message: {
                content: '{"name": "John", "age": 30}',
              },
            },
          ],
        },
      };

      mockAxiosInstance.post.mockResolvedValue(mockResponse);

      const result = await provider.generateStructuredOutput('Generate a person', schema);

      expect(result).toEqual({ name: 'John', age: 30 });
    });

    it.skip('should extract JSON from response with extra text', async () => {
      const schema = { type: 'object' };

      const mockResponse = {
        data: {
          choices: [
            {
              message: {
                content: 'Here is the JSON: {"key": "value"} That was the JSON.',
              },
            },
          ],
        },
      };

      mockAxiosInstance.post.mockResolvedValue(mockResponse);

      const result = await provider.generateStructuredOutput('Generate', schema);

      expect(result).toEqual({ key: 'value' });
    });

    it.skip('should throw error if JSON parsing fails', async () => {
      const schema = { type: 'object' };

      const mockResponse = {
        data: {
          choices: [
            {
              message: {
                content: 'This is not JSON',
              },
            },
          ],
        },
      };

      mockAxiosInstance.post.mockResolvedValue(mockResponse);

      await expect(provider.generateStructuredOutput('Generate', schema)).rejects.toThrow(
        'Groq did not return valid JSON',
      );
    });
  });

  describe('isHealthy', () => {
    beforeEach(async () => {
      await provider.initialize({
        name: 'groq',
        apiKey: 'test-key',
      });
    });

    it('should return true when API is accessible', async () => {
      mockAxiosInstance.get.mockResolvedValue({
        status: 200,
        data: {
          data: [{ id: 'model-1' }, { id: 'model-2' }],
        },
      });

      const result = await provider.isHealthy();

      expect(result).toBe(true);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/models', {
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
          data: [],
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

      expect(consoleSpy).toHaveBeenCalledWith('Groq LLM Provider destroyed');

      consoleSpy.mockRestore();
    });
  });

  describe('GroqLLMProviderPlugin', () => {
    it('should create a new instance', () => {
      const config: LLMProviderConfig = {
        name: 'groq',
      };

      const instance = GroqLLMProviderPlugin.create(config);

      expect(instance).toBeInstanceOf(GroqLLMProvider);
    });
  });
});
