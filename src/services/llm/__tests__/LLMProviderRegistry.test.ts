import { LLMProviderRegistry } from '../LLMProviderRegistry';
import { LLMProviderPlugin, LLMProvider, LLMProviderConfig } from '../../../types';

describe('LLMProviderRegistry', () => {
  let mockPlugin: LLMProviderPlugin;
  let mockProvider: LLMProvider;

  beforeEach(() => {
    // Clear the registry before each test
    LLMProviderRegistry['plugins'].clear();
    LLMProviderRegistry['instances'].clear();

    // Create mock provider
    mockProvider = {
      name: 'test-provider',
      initialize: jest.fn().mockResolvedValue(undefined),
      generateCompletion: jest.fn().mockResolvedValue('test completion'),
      generateStructuredOutput: jest.fn().mockResolvedValue({}),
      isHealthy: jest.fn().mockResolvedValue(true),
      destroy: jest.fn().mockResolvedValue(undefined),
    };

    // Create mock plugin
    mockPlugin = {
      create: jest.fn().mockReturnValue(mockProvider),
    };
  });

  describe('registerPlugin', () => {
    it('should register a new plugin', () => {
      LLMProviderRegistry.registerPlugin('test-plugin', mockPlugin);
      expect(LLMProviderRegistry.getAvailablePlugins()).toContain('test-plugin');
    });

    it('should throw error when registering duplicate plugin', () => {
      LLMProviderRegistry.registerPlugin('test-plugin', mockPlugin);
      expect(() => {
        LLMProviderRegistry.registerPlugin('test-plugin', mockPlugin);
      }).toThrow("LLM provider plugin 'test-plugin' is already registered");
    });
  });

  describe('createProvider', () => {
    it('should create a provider from registered plugin', async () => {
      LLMProviderRegistry.registerPlugin('test-plugin', mockPlugin);

      const config: LLMProviderConfig = {
        name: 'test-plugin',
        apiKey: 'test-key',
        model: 'gpt-4',
      };

      const provider = await LLMProviderRegistry.createProvider(config);

      expect(mockPlugin.create).toHaveBeenCalledWith(config);
      expect(mockProvider.initialize).toHaveBeenCalledWith(config);
      expect(provider).toBe(mockProvider);
    });

    it('should throw error for unregistered plugin', async () => {
      const config: LLMProviderConfig = {
        name: 'unknown-plugin',
      };

      await expect(LLMProviderRegistry.createProvider(config)).rejects.toThrow(
        "LLM provider plugin 'unknown-plugin' not found",
      );
    });
  });

  describe('destroyAllProviders', () => {
    it('should destroy all provider instances', async () => {
      LLMProviderRegistry.registerPlugin('test-plugin', mockPlugin);

      const config: LLMProviderConfig = {
        name: 'test-plugin',
      };

      await LLMProviderRegistry.createProvider(config);
      await LLMProviderRegistry.destroyAllProviders();

      expect(mockProvider.destroy).toHaveBeenCalled();
    });
  });
});
