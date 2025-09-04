import { NewsServiceRegistry } from '../NewsServiceRegistry';
import { NewsServicePlugin, NewsService, NewsServiceConfig } from '../../../types';

describe('NewsServiceRegistry', () => {
  let mockPlugin: NewsServicePlugin;
  let mockService: NewsService;

  beforeEach(() => {
    // Clear the registry before each test
    NewsServiceRegistry['plugins'].clear();
    NewsServiceRegistry['instances'].clear();

    // Create mock service
    mockService = {
      name: 'test-service',
      initialize: jest.fn().mockResolvedValue(undefined),
      fetchLatestNews: jest.fn().mockResolvedValue([]),
      searchNews: jest.fn().mockResolvedValue([]),
      isHealthy: jest.fn().mockResolvedValue(true),
      destroy: jest.fn().mockResolvedValue(undefined),
    };

    // Create mock plugin
    mockPlugin = {
      create: jest.fn().mockReturnValue(mockService),
    };
  });

  describe('registerPlugin', () => {
    it('should register a new plugin', () => {
      NewsServiceRegistry.registerPlugin('test-plugin', mockPlugin);
      expect(NewsServiceRegistry.getAvailablePlugins()).toContain('test-plugin');
    });

    it('should throw error when registering duplicate plugin', () => {
      NewsServiceRegistry.registerPlugin('test-plugin', mockPlugin);
      expect(() => {
        NewsServiceRegistry.registerPlugin('test-plugin', mockPlugin);
      }).toThrow("News service plugin 'test-plugin' is already registered");
    });
  });

  describe('unregisterPlugin', () => {
    it('should unregister a plugin', () => {
      NewsServiceRegistry.registerPlugin('test-plugin', mockPlugin);
      NewsServiceRegistry.unregisterPlugin('test-plugin');
      expect(NewsServiceRegistry.getAvailablePlugins()).not.toContain('test-plugin');
    });
  });

  describe('createService', () => {
    it('should create a service from registered plugin', async () => {
      NewsServiceRegistry.registerPlugin('test-plugin', mockPlugin);

      const config: NewsServiceConfig = {
        name: 'test-plugin',
        apiKey: 'test-key',
      };

      const service = await NewsServiceRegistry.createService(config);

      expect(mockPlugin.create).toHaveBeenCalledWith(config);
      expect(mockService.initialize).toHaveBeenCalledWith(config);
      expect(service).toBe(mockService);
    });

    it('should throw error for unregistered plugin', async () => {
      const config: NewsServiceConfig = {
        name: 'unknown-plugin',
      };

      await expect(NewsServiceRegistry.createService(config)).rejects.toThrow(
        "News service plugin 'unknown-plugin' not found",
      );
    });
  });

  describe('destroyAllServices', () => {
    it('should destroy all service instances', async () => {
      NewsServiceRegistry.registerPlugin('test-plugin', mockPlugin);

      const config: NewsServiceConfig = {
        name: 'test-plugin',
      };

      await NewsServiceRegistry.createService(config);
      await NewsServiceRegistry.destroyAllServices();

      expect(mockService.destroy).toHaveBeenCalled();
    });
  });
});
