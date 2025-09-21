import { BettingPlatformRegistry } from '../BettingPlatformRegistry';
import { BettingPlatformPlugin, BettingPlatform, BettingPlatformConfig } from '../../../types';

describe('BettingPlatformRegistry', () => {
  let mockPlugin: BettingPlatformPlugin;
  let mockPlatform: BettingPlatform;

  beforeEach(() => {
    // Clear the registry before each test
    BettingPlatformRegistry['plugins'].clear();
    BettingPlatformRegistry['instances'].clear();

    // Create mock platform
    mockPlatform = {
      name: 'test-platform',
      initialize: jest.fn().mockResolvedValue(undefined),
      getAvailableContracts: jest.fn().mockResolvedValue([]),
      getContract: jest.fn().mockResolvedValue(null),
      placeOrder: jest.fn().mockResolvedValue({
        orderId: 'test-order-1',
        status: 'filled' as const,
        filledQuantity: 10,
        averagePrice: 0.5,
        timestamp: new Date(),
      }),
      cancelOrder: jest.fn().mockResolvedValue(true),
      getPositions: jest.fn().mockResolvedValue([]),
      getBalance: jest.fn().mockResolvedValue(10000),
      getMarketResolution: jest.fn().mockResolvedValue(null),
      isHealthy: jest.fn().mockResolvedValue(true),
      destroy: jest.fn().mockResolvedValue(undefined),
    };

    // Create mock plugin
    mockPlugin = {
      create: jest.fn().mockReturnValue(mockPlatform),
    };
  });

  describe('registerPlugin', () => {
    it('should register a new plugin', () => {
      BettingPlatformRegistry.registerPlugin('test-plugin', mockPlugin);
      expect(BettingPlatformRegistry.getAvailablePlugins()).toContain('test-plugin');
    });

    it('should throw error when registering duplicate plugin', () => {
      BettingPlatformRegistry.registerPlugin('test-plugin', mockPlugin);
      expect(() => {
        BettingPlatformRegistry.registerPlugin('test-plugin', mockPlugin);
      }).toThrow("Betting platform plugin 'test-plugin' is already registered");
    });
  });

  describe('createPlatform', () => {
    it('should create a platform from registered plugin', async () => {
      BettingPlatformRegistry.registerPlugin('test-plugin', mockPlugin);

      const config: BettingPlatformConfig = {
        name: 'test-plugin',
        apiKey: 'test-key',
      };

      const platform = await BettingPlatformRegistry.createPlatform(config);

      expect(mockPlugin.create).toHaveBeenCalledWith(config);
      expect(mockPlatform.initialize).toHaveBeenCalledWith(config);
      expect(platform).toBe(mockPlatform);
    });

    it('should throw error for unregistered plugin', async () => {
      const config: BettingPlatformConfig = {
        name: 'unknown-plugin',
      };

      await expect(BettingPlatformRegistry.createPlatform(config)).rejects.toThrow(
        "Betting platform plugin 'unknown-plugin' not found",
      );
    });
  });

  describe('destroyAllPlatforms', () => {
    it('should destroy all platform instances', async () => {
      BettingPlatformRegistry.registerPlugin('test-plugin', mockPlugin);

      const config: BettingPlatformConfig = {
        name: 'test-plugin',
      };

      await BettingPlatformRegistry.createPlatform(config);
      await BettingPlatformRegistry.destroyAllPlatforms();

      expect(mockPlatform.destroy).toHaveBeenCalled();
    });
  });
});
