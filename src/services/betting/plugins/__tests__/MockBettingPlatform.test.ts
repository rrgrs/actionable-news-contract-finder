import { MockBettingPlatform, MockBettingPlatformPlugin } from '../MockBettingPlatform';
import { BettingPlatformConfig } from '../../../../types';

describe('MockBettingPlatform', () => {
  let platform: MockBettingPlatform;
  let config: BettingPlatformConfig;

  beforeEach(() => {
    config = {
      name: 'mock-betting',
      testMode: true,
    };
    platform = new MockBettingPlatform(config);
  });

  describe('initialization', () => {
    it('should initialize successfully', async () => {
      await expect(platform.initialize(config)).resolves.not.toThrow();
      await expect(platform.isHealthy()).resolves.toBe(true);
    });

    it('should set the platform name', () => {
      expect(platform.name).toBe('mock-betting');
    });
  });

  describe('searchMarkets', () => {
    it('should search markets by query', async () => {
      await platform.initialize(config);
      const markets = await platform.searchMarkets('Fed');

      expect(markets).toBeInstanceOf(Array);
      expect(markets.length).toBeGreaterThan(0);

      markets.forEach((market) => {
        const hasMatch =
          market.title.toLowerCase().includes('fed') ||
          market.description.toLowerCase().includes('fed');
        expect(hasMatch).toBe(true);
      });
    });

    it('should return proper market structure', async () => {
      await platform.initialize(config);
      const markets = await platform.searchMarkets('');

      markets.forEach((market) => {
        expect(market).toMatchObject({
          id: expect.any(String),
          platform: expect.any(String),
          title: expect.any(String),
          description: expect.any(String),
          url: expect.any(String),
          createdAt: expect.any(Date),
        });
      });
    });

    it('should throw error when not initialized', async () => {
      await expect(platform.searchMarkets('test')).rejects.toThrow('Platform not initialized');
    });
  });

  describe('getMarket', () => {
    it('should get a specific market', async () => {
      await platform.initialize(config);
      const markets = await platform.searchMarkets('');
      const marketId = markets[0].id;

      const market = await platform.getMarket(marketId);
      expect(market.id).toBe(marketId);
    });

    it('should throw error for non-existent market', async () => {
      await platform.initialize(config);
      await expect(platform.getMarket('non-existent-id')).rejects.toThrow('not found');
    });
  });

  describe('getContracts', () => {
    it('should get contracts for a market', async () => {
      await platform.initialize(config);
      const markets = await platform.searchMarkets('');
      const marketId = markets[0].id;

      const contracts = await platform.getContracts(marketId);

      expect(contracts).toBeInstanceOf(Array);
      expect(contracts.length).toBe(2); // YES and NO contracts

      const yesContract = contracts.find((c) => c.outcome === 'YES');
      const noContract = contracts.find((c) => c.outcome === 'NO');

      expect(yesContract).toBeDefined();
      expect(noContract).toBeDefined();
    });

    it('should return proper contract structure', async () => {
      await platform.initialize(config);
      const contracts = await platform.getContracts('test-market');

      contracts.forEach((contract) => {
        expect(contract).toMatchObject({
          id: expect.any(String),
          marketId: expect.any(String),
          platform: expect.any(String),
          title: expect.any(String),
          description: expect.any(String),
          outcome: expect.any(String),
          currentPrice: expect.any(Number),
        });
      });
    });
  });

  describe('placeOrder', () => {
    it('should place a buy order', async () => {
      await platform.initialize(config);
      const contracts = await platform.getContracts('test-market');
      const contract = contracts[0];

      const position = await platform.placeOrder(contract.id, 'buy', 10, 0.5);

      expect(position).toMatchObject({
        id: expect.any(String),
        contractId: contract.id,
        platform: platform.name,
        side: 'buy',
        quantity: 10,
        price: 0.5,
        status: 'filled',
      });
    });

    it('should use current price if not specified', async () => {
      await platform.initialize(config);
      const contracts = await platform.getContracts('test-market');
      const contract = contracts[0];

      const position = await platform.placeOrder(contract.id, 'buy', 10);

      expect(position.price).toBe(contract.currentPrice);
    });
  });

  describe('getPosition', () => {
    it('should retrieve a position', async () => {
      await platform.initialize(config);
      const contracts = await platform.getContracts('test-market');
      const position = await platform.placeOrder(contracts[0].id, 'buy', 10, 0.5);

      const retrieved = await platform.getPosition(position.id);
      expect(retrieved).toEqual(position);
    });

    it('should throw error for non-existent position', async () => {
      await platform.initialize(config);
      await expect(platform.getPosition('non-existent')).rejects.toThrow('not found');
    });
  });

  describe('getPositions', () => {
    it('should retrieve all positions', async () => {
      await platform.initialize(config);
      const contracts = await platform.getContracts('test-market');

      const position1 = await platform.placeOrder(contracts[0].id, 'buy', 10, 0.5);
      const position2 = await platform.placeOrder(contracts[1].id, 'sell', 5, 0.3);

      const positions = await platform.getPositions();

      expect(positions).toHaveLength(2);
      expect(positions).toContainEqual(position1);
      expect(positions).toContainEqual(position2);
    });
  });

  describe('cancelOrder', () => {
    it('should cancel an order', async () => {
      await platform.initialize(config);
      const contracts = await platform.getContracts('test-market');
      const position = await platform.placeOrder(contracts[0].id, 'buy', 10, 0.5);

      await platform.cancelOrder(position.id);

      const updated = await platform.getPosition(position.id);
      expect(updated.status).toBe('cancelled');
    });

    it('should throw error for non-existent position', async () => {
      await platform.initialize(config);
      await expect(platform.cancelOrder('non-existent')).rejects.toThrow('not found');
    });
  });

  describe('destroy', () => {
    it('should destroy the platform', async () => {
      await platform.initialize(config);
      const contracts = await platform.getContracts('test-market');
      await platform.placeOrder(contracts[0].id, 'buy', 10, 0.5);

      await platform.destroy();

      await expect(platform.isHealthy()).resolves.toBe(false);
    });
  });
});

describe('MockBettingPlatformPlugin', () => {
  it('should create a MockBettingPlatform instance', () => {
    const config: BettingPlatformConfig = {
      name: 'mock-betting',
    };

    const platform = MockBettingPlatformPlugin.create(config);

    expect(platform).toBeInstanceOf(MockBettingPlatform);
    expect(platform.name).toBe('mock-betting');
  });
});
