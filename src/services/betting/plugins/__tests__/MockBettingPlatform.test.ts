import { MockBettingPlatform, MockBettingPlatformPlugin } from '../MockBettingPlatform';
import { BettingPlatformConfig, Order } from '../../../../types';

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

  describe('getAvailableContracts', () => {
    it('should return available contracts', async () => {
      await platform.initialize(config);
      const contracts = await platform.getAvailableContracts();

      expect(contracts).toBeInstanceOf(Array);
      expect(contracts.length).toBeGreaterThan(0);

      contracts.forEach((contract) => {
        expect(contract).toMatchObject({
          id: expect.any(String),
          platform: expect.any(String),
          title: expect.any(String),
          yesPrice: expect.any(Number),
          noPrice: expect.any(Number),
          volume: expect.any(Number),
          liquidity: expect.any(Number),
          endDate: expect.any(Date),
          tags: expect.any(Array),
          url: expect.any(String),
        });
      });
    });

    it('should throw error when not initialized', async () => {
      await expect(platform.getAvailableContracts()).rejects.toThrow('Platform not initialized');
    });
  });

  describe('getContract', () => {
    it('should get a specific contract', async () => {
      await platform.initialize(config);
      const contracts = await platform.getAvailableContracts();
      const contractId = contracts[0].id;

      const contract = await platform.getContract(contractId);
      expect(contract).not.toBeNull();
      expect(contract?.id).toBe(contractId);
    });

    it('should return null for non-existent contract', async () => {
      await platform.initialize(config);
      const contract = await platform.getContract('non-existent-id');
      expect(contract).toBeNull();
    });
  });

  describe('placeOrder', () => {
    it('should place a market order for YES', async () => {
      await platform.initialize(config);
      const contracts = await platform.getAvailableContracts();
      const contract = contracts[0];

      const order: Order = {
        contractId: contract.id,
        platform: platform.name,
        side: 'yes',
        quantity: 10,
        orderType: 'market',
      };

      const orderStatus = await platform.placeOrder(order);

      expect(orderStatus).toMatchObject({
        orderId: expect.any(String),
        status: 'filled',
        filledQuantity: 10,
        averagePrice: contract.yesPrice,
        timestamp: expect.any(Date),
      });
    });

    it('should place a limit order for NO', async () => {
      await platform.initialize(config);
      const contracts = await platform.getAvailableContracts();
      const contract = contracts[0];

      const order: Order = {
        contractId: contract.id,
        platform: platform.name,
        side: 'no',
        quantity: 5,
        orderType: 'limit',
        limitPrice: 0.4,
      };

      const orderStatus = await platform.placeOrder(order);

      expect(orderStatus).toMatchObject({
        orderId: expect.any(String),
        status: 'filled',
        filledQuantity: 5,
        averagePrice: 0.4,
        timestamp: expect.any(Date),
      });
    });

    it('should use current price if not specified', async () => {
      await platform.initialize(config);
      const contracts = await platform.getAvailableContracts();
      const contract = contracts[0];

      const order: Order = {
        contractId: contract.id,
        platform: platform.name,
        side: 'yes',
        quantity: 10,
        orderType: 'market',
      };

      const orderStatus = await platform.placeOrder(order);
      expect(orderStatus.averagePrice).toBe(contract.yesPrice);
    });
  });

  describe('cancelOrder', () => {
    it('should cancel an order', async () => {
      await platform.initialize(config);
      const contracts = await platform.getAvailableContracts();
      const contract = contracts[0];

      const order: Order = {
        contractId: contract.id,
        platform: platform.name,
        side: 'yes',
        quantity: 10,
        orderType: 'market',
      };

      const orderStatus = await platform.placeOrder(order);
      const cancelled = await platform.cancelOrder(orderStatus.orderId);

      expect(cancelled).toBe(true);
    });

    it('should return false for non-existent order', async () => {
      await platform.initialize(config);
      const cancelled = await platform.cancelOrder('non-existent');
      expect(cancelled).toBe(false);
    });
  });

  describe('getPositions', () => {
    it('should retrieve positions after placing orders', async () => {
      await platform.initialize(config);
      const contracts = await platform.getAvailableContracts();
      const contract = contracts[0];

      const order1: Order = {
        contractId: contract.id,
        platform: platform.name,
        side: 'yes',
        quantity: 10,
        orderType: 'market',
      };

      const order2: Order = {
        contractId: contracts[1].id,
        platform: platform.name,
        side: 'no',
        quantity: 5,
        orderType: 'market',
      };

      await platform.placeOrder(order1);
      await platform.placeOrder(order2);

      const positions = await platform.getPositions();

      expect(positions).toHaveLength(2);
      expect(positions[0]).toMatchObject({
        contractId: expect.any(String),
        platform: platform.name,
        quantity: expect.any(Number),
        side: expect.stringMatching(/^(yes|no)$/),
        averagePrice: expect.any(Number),
        currentPrice: expect.any(Number),
      });
    });
  });

  describe('getBalance', () => {
    it('should return account balance', async () => {
      await platform.initialize(config);
      const balance = await platform.getBalance();
      expect(balance).toBe(10000);
    });
  });

  describe('getMarketResolution', () => {
    it('should return null for unresolved markets', async () => {
      await platform.initialize(config);
      const contracts = await platform.getAvailableContracts();
      const resolution = await platform.getMarketResolution(contracts[0].id);
      expect(resolution).toBeNull();
    });
  });

  describe('destroy', () => {
    it('should destroy the platform', async () => {
      await platform.initialize(config);
      const contracts = await platform.getAvailableContracts();

      const order: Order = {
        contractId: contracts[0].id,
        platform: platform.name,
        side: 'yes',
        quantity: 10,
        orderType: 'market',
      };

      await platform.placeOrder(order);

      await platform.destroy();
      await expect(platform.isHealthy()).resolves.toBe(false);
    });
  });

  describe('MockBettingPlatformPlugin', () => {
    it('should create a new instance', () => {
      const instance = MockBettingPlatformPlugin.create(config);
      expect(instance).toBeInstanceOf(MockBettingPlatform);
    });
  });
});
