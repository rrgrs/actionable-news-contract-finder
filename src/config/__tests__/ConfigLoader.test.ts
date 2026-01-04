import { ConfigLoader } from '../ConfigLoader';
import * as path from 'path';
import { NewsServicePlugin, BettingPlatformPlugin, LLMProviderPlugin } from '../../types';
import { AppConfig } from '../types';

// Helper to create a valid full config for tests
const createTestConfig = (overrides?: Partial<AppConfig>): AppConfig => ({
  newsServices: [],
  bettingPlatforms: [],
  llmProviders: [],
  embedding: {
    apiKey: 'test-api-key',
  },
  matching: {
    topN: 20,
  },
  validation: {
    minConfidenceScore: 0.6,
    dryRun: true,
    placeBets: false,
  },
  alerts: { type: 'none' as const },
  logLevel: 'info',
  ...overrides,
});

// Type definitions for mock registries
type MockNewsRegistry = {
  registerPlugin: jest.Mock;
  createService: jest.Mock;
};

type MockBettingRegistry = {
  registerPlugin: jest.Mock;
  createPlatform: jest.Mock;
};

type MockLLMRegistry = {
  registerPlugin: jest.Mock;
  createProvider: jest.Mock;
};

describe('ConfigLoader', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset modules and environment before each test
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('loadConfig', () => {
    it('should load configuration from environment variables', () => {
      process.env.NEWS_SERVICES = 'news1,news2';
      process.env.BETTING_PLATFORMS = 'betting1';
      process.env.LLM_PROVIDERS = 'llm1,llm2,llm3';
      process.env.MIN_CONFIDENCE_SCORE = '0.8';
      process.env.DRY_RUN = 'false';
      process.env.PLACE_BETS = 'true';
      process.env.LOG_LEVEL = 'debug';
      process.env.GEMINI_API_KEY = 'test-key';
      process.env.TOP_MATCHING_MARKETS = '30';
      // Explicitly unset ALERT_TYPE to test default
      delete process.env.ALERT_TYPE;

      const config = ConfigLoader.loadConfig();

      expect(config.newsServices).toHaveLength(2);
      expect(config.newsServices[0].name).toBe('news1');
      expect(config.newsServices[1].name).toBe('news2');
      expect(config.bettingPlatforms).toHaveLength(1);
      expect(config.bettingPlatforms[0].name).toBe('betting1');
      expect(config.llmProviders).toHaveLength(3);
      expect(config.validation.minConfidenceScore).toBe(0.8);
      expect(config.validation.dryRun).toBe(false);
      expect(config.validation.placeBets).toBe(true);
      expect(config.matching.topN).toBe(30);
      expect(config.embedding.apiKey).toBe('test-key');
      expect(config.alerts.type).toBe('none');
      expect(config.logLevel).toBe('debug');
    });

    it('should use defaults when services are not configured', () => {
      delete process.env.NEWS_SERVICES;
      delete process.env.BETTING_PLATFORMS;
      delete process.env.LLM_PROVIDERS;

      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      const config = ConfigLoader.loadConfig();

      expect(config.newsServices).toHaveLength(1);
      expect(config.newsServices[0].name).toBe('mock-news');
      expect(config.bettingPlatforms).toHaveLength(1);
      expect(config.bettingPlatforms[0].name).toBe('mock-betting');
      expect(config.llmProviders).toHaveLength(1);
      expect(config.llmProviders[0].name).toBe('mock-llm');

      expect(consoleSpy).toHaveBeenCalledWith('No news services configured, using mock-news');
      expect(consoleSpy).toHaveBeenCalledWith(
        'No betting platforms configured, using mock-betting',
      );
      expect(consoleSpy).toHaveBeenCalledWith('No LLM providers configured, using mock-llm');

      consoleSpy.mockRestore();
    });

    it('should parse service-specific configuration', () => {
      process.env.NEWS_SERVICES = 'custom-news';
      process.env.NEWS_CUSTOM_NEWS_APIKEY = 'test-key';
      process.env.NEWS_CUSTOM_NEWS_BASEURL = 'https://api.test.com';
      process.env.BETTING_PLATFORMS = 'custom-betting';
      process.env.BETTING_CUSTOM_BETTING_SECRET = 'secret123';
      process.env.LLM_PROVIDERS = 'custom-llm';
      process.env.LLM_CUSTOM_LLM_MODEL = 'gpt-4';

      const config = ConfigLoader.loadConfig();

      expect(config.newsServices[0].config).toEqual({
        name: 'custom-news',
        apikey: 'test-key',
        baseurl: 'https://api.test.com',
      });
      expect(config.bettingPlatforms[0].config).toEqual({
        name: 'custom-betting',
        secret: 'secret123',
      });
      expect(config.llmProviders[0].config).toEqual({
        name: 'custom-llm',
        model: 'gpt-4',
      });
    });

    it('should handle empty service lists', () => {
      process.env.NEWS_SERVICES = '';
      process.env.BETTING_PLATFORMS = '  ';
      process.env.LLM_PROVIDERS = ',,,';

      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      const config = ConfigLoader.loadConfig();

      // Should fall back to defaults
      expect(config.newsServices[0].name).toBe('mock-news');
      expect(config.bettingPlatforms[0].name).toBe('mock-betting');
      expect(config.llmProviders[0].name).toBe('mock-llm');

      consoleSpy.mockRestore();
    });

    it('should trim whitespace from service names', () => {
      process.env.NEWS_SERVICES = '  service1  , service2  ';
      process.env.BETTING_PLATFORMS = 'mock-betting';
      process.env.LLM_PROVIDERS = 'mock-llm';

      const config = ConfigLoader.loadConfig();

      expect(config.newsServices[0].name).toBe('service1');
      expect(config.newsServices[1].name).toBe('service2');
    });
  });

  describe('findAndLoadPlugin', () => {
    it('should find plugin by exact name match', async () => {
      // This test uses the actual mock plugins in the project
      const servicePath = path.join(__dirname, '../../services/news');
      const serviceConfig = {
        name: 'mock-news',
        fileName: 'mocknews',
        config: { name: 'mock-news' },
      };

      const result = await ConfigLoader.findAndLoadPlugin<NewsServicePlugin>(
        servicePath,
        serviceConfig,
      );

      expect(result.exportName).toBe('MockNewsServicePlugin');
      expect(result.plugin).toBeDefined();
      expect(result.plugin.create).toBeDefined();
    });

    it('should find plugin by partial name match', async () => {
      const servicePath = path.join(__dirname, '../../services/betting');
      const serviceConfig = {
        name: 'mockbetting',
        fileName: 'mockbetting',
        config: { name: 'mockbetting' },
      };

      const result = await ConfigLoader.findAndLoadPlugin<BettingPlatformPlugin>(
        servicePath,
        serviceConfig,
      );

      expect(result.exportName).toBe('MockBettingPlatformPlugin');
      expect(result.plugin).toBeDefined();
    });

    it('should find plugin by file name match', async () => {
      const servicePath = path.join(__dirname, '../../services/llm');
      const serviceConfig = {
        name: 'MockLLMProvider',
        fileName: 'MockLLMProvider',
        config: { name: 'MockLLMProvider' },
      };

      const result = await ConfigLoader.findAndLoadPlugin<LLMProviderPlugin>(
        servicePath,
        serviceConfig,
      );

      expect(result.exportName).toBe('MockLLMProviderPlugin');
      expect(result.plugin).toBeDefined();
    });

    it('should throw error when plugin not found', async () => {
      const servicePath = path.join(__dirname, '../../services/news');
      const serviceConfig = {
        name: 'non-existent-service',
        fileName: 'nonexistent',
        config: { name: 'non-existent-service' },
      };

      await expect(
        ConfigLoader.findAndLoadPlugin<NewsServicePlugin>(servicePath, serviceConfig),
      ).rejects.toThrow(/No plugin found for service 'non-existent-service'/);
    });

    it('should list available plugins in error message', async () => {
      const servicePath = path.join(__dirname, '../../services/news');
      const serviceConfig = {
        name: 'invalid',
        fileName: 'invalid',
        config: { name: 'invalid' },
      };

      try {
        await ConfigLoader.findAndLoadPlugin<NewsServicePlugin>(servicePath, serviceConfig);
        fail('Should have thrown an error');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        const errorMessage = (error as Error).message;
        expect(errorMessage).toContain('Available plugins');
        expect(errorMessage).toContain('MockNewsServicePlugin');
      }
    });
  });

  describe('validateConfiguration', () => {
    it('should validate all configured services', async () => {
      const config = createTestConfig({
        newsServices: [
          {
            name: 'mock-news',
            fileName: 'mocknews',
            config: { name: 'mock-news' },
          },
        ],
        bettingPlatforms: [
          {
            name: 'mock-betting',
            fileName: 'mockbetting',
            config: { name: 'mock-betting' },
          },
        ],
        llmProviders: [
          {
            name: 'mock-llm',
            fileName: 'mockllm',
            config: { name: 'mock-llm' },
          },
        ],
      });

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      await expect(ConfigLoader.validateConfiguration(config)).resolves.not.toThrow();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("News service 'mock-news' validated"),
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Betting platform 'mock-betting' validated"),
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("LLM provider 'mock-llm' validated"),
      );

      consoleSpy.mockRestore();
    });

    it('should throw error with details when validation fails', async () => {
      const config = createTestConfig({
        newsServices: [
          {
            name: 'invalid-news',
            fileName: 'invalid',
            config: { name: 'invalid-news' },
          },
        ],
        bettingPlatforms: [
          {
            name: 'invalid-betting',
            fileName: 'invalid',
            config: { name: 'invalid-betting' },
          },
        ],
        llmProviders: [],
      });

      await expect(ConfigLoader.validateConfiguration(config)).rejects.toThrow(
        /Configuration validation failed/,
      );

      try {
        await ConfigLoader.validateConfiguration(config);
      } catch (error) {
        const errorMessage = (error as Error).message;
        expect(errorMessage).toContain("News service 'invalid-news'");
        expect(errorMessage).toContain("Betting platform 'invalid-betting'");
      }
    });

    it('should fail validation when embedding API key is missing', async () => {
      const config = createTestConfig({
        newsServices: [
          {
            name: 'mock-news',
            fileName: 'mocknews',
            config: { name: 'mock-news' },
          },
        ],
        bettingPlatforms: [
          {
            name: 'mock-betting',
            fileName: 'mockbetting',
            config: { name: 'mock-betting' },
          },
        ],
        llmProviders: [
          {
            name: 'mock-llm',
            fileName: 'mockllm',
            config: { name: 'mock-llm' },
          },
        ],
        embedding: {
          apiKey: '', // Empty API key
        },
      });

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      await expect(ConfigLoader.validateConfiguration(config)).rejects.toThrow(
        /Embedding API key not configured/,
      );

      consoleSpy.mockRestore();
    });
  });

  describe('loadAndRegisterServices', () => {
    it('should load and register all services', async () => {
      const config = createTestConfig({
        newsServices: [
          {
            name: 'mock-news',
            fileName: 'mocknews',
            config: { name: 'mock-news' },
          },
        ],
        bettingPlatforms: [
          {
            name: 'mock-betting',
            fileName: 'mockbetting',
            config: { name: 'mock-betting' },
          },
        ],
        llmProviders: [
          {
            name: 'mock-llm',
            fileName: 'mockllm',
            config: { name: 'mock-llm' },
          },
        ],
      });

      const mockNewsRegistry: MockNewsRegistry = {
        registerPlugin: jest.fn(),
        createService: jest.fn().mockResolvedValue({ name: 'mock-news-instance' }),
      };

      const mockBettingRegistry: MockBettingRegistry = {
        registerPlugin: jest.fn(),
        createPlatform: jest.fn().mockResolvedValue({ name: 'mock-betting-instance' }),
      };

      const mockLLMRegistry: MockLLMRegistry = {
        registerPlugin: jest.fn(),
        createProvider: jest.fn().mockResolvedValue({ name: 'mock-llm-instance' }),
      };

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      const result = await ConfigLoader.loadAndRegisterServices(
        config,
        mockNewsRegistry as unknown as typeof import('../../services/news/NewsServiceRegistry').NewsServiceRegistry,
        mockBettingRegistry as unknown as typeof import('../../services/betting/BettingPlatformRegistry').BettingPlatformRegistry,
        mockLLMRegistry as unknown as typeof import('../../services/llm/LLMProviderRegistry').LLMProviderRegistry,
      );

      expect(result.newsServices).toHaveLength(1);
      expect(result.bettingPlatforms).toHaveLength(1);
      expect(result.llmProviders).toHaveLength(1);

      expect(mockNewsRegistry.registerPlugin).toHaveBeenCalledWith(
        'mock-news',
        expect.objectContaining({ create: expect.any(Function) }),
      );
      expect(mockBettingRegistry.registerPlugin).toHaveBeenCalledWith(
        'mock-betting',
        expect.objectContaining({ create: expect.any(Function) }),
      );
      expect(mockLLMRegistry.registerPlugin).toHaveBeenCalledWith(
        'mock-llm',
        expect.objectContaining({ create: expect.any(Function) }),
      );

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Loaded news service: mock-news'),
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Loaded betting platform: mock-betting'),
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Loaded LLM provider: mock-llm'),
      );

      consoleSpy.mockRestore();
    });
  });
});
