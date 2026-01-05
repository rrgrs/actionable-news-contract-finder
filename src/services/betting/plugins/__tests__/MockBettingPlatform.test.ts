import { MockBettingPlatform, MockBettingPlatformPlugin } from '../MockBettingPlatform';
import { BettingPlatformConfig } from '../../../../types';

describe('MockBettingPlatform', () => {
  let platform: MockBettingPlatform;
  const config: BettingPlatformConfig = {
    name: 'mock-betting',
    testMode: true,
  };

  beforeEach(async () => {
    platform = new MockBettingPlatform(config);
    await platform.initialize(config);
  });

  afterEach(async () => {
    await platform.destroy();
  });

  describe('initialize', () => {
    it('should set the platform name from config', () => {
      expect(platform.name).toBe('mock-betting');
    });

    it('should be healthy after initialization', async () => {
      expect(await platform.isHealthy()).toBe(true);
    });
  });

  describe('getMarkets', () => {
    it('should return mock markets with contracts', async () => {
      const markets = await platform.getMarkets();

      expect(markets.length).toBeGreaterThan(0);
      expect(markets[0]).toHaveProperty('id');
      expect(markets[0]).toHaveProperty('platform');
      expect(markets[0]).toHaveProperty('title');
      expect(markets[0]).toHaveProperty('url');
      expect(markets[0]).toHaveProperty('contracts');
      expect(markets[0].contracts.length).toBeGreaterThan(0);
    });

    it('should return contracts with required fields', async () => {
      const markets = await platform.getMarkets();
      const contract = markets[0].contracts[0];

      expect(contract).toHaveProperty('id');
      expect(contract).toHaveProperty('title');
      expect(contract).toHaveProperty('yesPrice');
      expect(contract).toHaveProperty('noPrice');
      expect(contract).toHaveProperty('volume');
      expect(contract).toHaveProperty('liquidity');
    });

    it('should throw error if not initialized', async () => {
      const uninitializedPlatform = new MockBettingPlatform(config);

      await expect(uninitializedPlatform.getMarkets()).rejects.toThrow('Platform not initialized');
    });
  });

  describe('isHealthy', () => {
    it('should return true when initialized', async () => {
      expect(await platform.isHealthy()).toBe(true);
    });

    it('should return false when not initialized', async () => {
      const uninitializedPlatform = new MockBettingPlatform(config);
      expect(await uninitializedPlatform.isHealthy()).toBe(false);
    });
  });

  describe('destroy', () => {
    it('should clear markets and set isHealthy to false', async () => {
      await platform.destroy();

      expect(await platform.isHealthy()).toBe(false);
    });
  });

  describe('MockBettingPlatformPlugin', () => {
    it('should create a MockBettingPlatform instance', () => {
      const instance = MockBettingPlatformPlugin.create(config);
      expect(instance).toBeInstanceOf(MockBettingPlatform);
    });
  });
});
