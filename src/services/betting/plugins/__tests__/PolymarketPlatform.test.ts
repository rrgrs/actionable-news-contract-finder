import { PolymarketPlatform, PolymarketPlatformPlugin } from '../PolymarketPlatform';
import axios from 'axios';
import { ethers } from 'ethers';
import { BettingPlatformConfig, Order } from '../../../../types';

jest.mock('axios');
jest.mock('ethers');

const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedEthers = ethers as jest.Mocked<typeof ethers>;

describe('PolymarketPlatform', () => {
  let platform: PolymarketPlatform;
  let mockAxiosInstance: {
    post: jest.Mock;
    get: jest.Mock;
    delete: jest.Mock;
    defaults: {
      headers: {
        common: Record<string, string>;
      };
    };
  };
  let mockDataClient: {
    get: jest.Mock;
  };

  beforeEach(() => {
    platform = new PolymarketPlatform();

    // Mock axios instances
    mockAxiosInstance = {
      post: jest.fn(),
      get: jest.fn(),
      delete: jest.fn(),
      defaults: {
        headers: {
          common: {},
        },
      },
    };

    mockDataClient = {
      get: jest.fn(),
    };

    mockedAxios.create = jest
      .fn()
      .mockReturnValueOnce(mockAxiosInstance)
      .mockReturnValueOnce(mockDataClient);

    // Mock ethers Wallet
    (mockedEthers.Wallet as unknown as jest.Mock) = jest.fn().mockImplementation(() => ({
      address: '0x1234567890123456789012345678901234567890',
      signMessage: jest.fn().mockResolvedValue('mock-signature'),
    }));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('initialize', () => {
    it('should initialize with API credentials and private key', async () => {
      const config: BettingPlatformConfig = {
        name: 'polymarket',
        apiKey: 'test-api-key',
        apiSecret: 'test-api-secret',
        customConfig: {
          privateKey: 'test-private-key',
        },
      };

      await platform.initialize(config);

      expect(mockedAxios.create).toHaveBeenCalledTimes(2);
      expect(mockedAxios.create).toHaveBeenCalledWith({
        baseURL: 'https://clob.polymarket.com',
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      });

      expect(mockAxiosInstance.defaults.headers.common['Authorization']).toBe(
        'Bearer test-api-key',
      );
      expect(mockAxiosInstance.defaults.headers.common['X-Api-Secret']).toBe('test-api-secret');
    });

    it('should work in read-only mode without credentials', async () => {
      const config: BettingPlatformConfig = {
        name: 'polymarket',
      };

      await platform.initialize(config);

      expect(mockedAxios.create).toHaveBeenCalledTimes(2);
      expect(mockAxiosInstance.defaults.headers.common['Authorization']).toBeUndefined();
    });

    it('should throw error if API key provided without private key', async () => {
      const config: BettingPlatformConfig = {
        name: 'polymarket',
        apiKey: 'test-api-key',
        apiSecret: 'test-api-secret',
      };

      await expect(platform.initialize(config)).rejects.toThrow(
        'Polymarket private key required for trading',
      );
    });
  });

  describe('getAvailableContracts', () => {
    beforeEach(async () => {
      const config: BettingPlatformConfig = {
        name: 'polymarket',
      };
      await platform.initialize(config);
    });

    it('should fetch and convert available contracts', async () => {
      const mockMarkets = {
        data: [
          {
            id: 'market-123',
            question: 'Will Bitcoin reach $100,000 by end of 2024?',
            conditionId: 'condition-123',
            slug: 'bitcoin-100k-2024',
            resolutionSource: 'CoinGecko',
            endDate: '2024-12-31T23:59:59Z',
            liquidity: '50000',
            volume: '1000000',
            volume24hr: '100000',
            clobTokenIds: ['token-yes', 'token-no'],
            outcomes: ['Yes', 'No'],
            outcomePrices: ['0.25', '0.75'],
            minimum_order_size: 1,
            minimum_tick_size: 0.01,
            description: 'Resolution based on CoinGecko price',
            tags: ['crypto', 'bitcoin'],
            active: true,
            closed: false,
            archived: false,
            accepting_orders: true,
            resolved: false,
          },
        ],
      };

      mockDataClient.get.mockResolvedValueOnce(mockMarkets);

      const contracts = await platform.getAvailableContracts();

      expect(contracts).toHaveLength(1);
      expect(contracts[0]).toMatchObject({
        id: 'market-123',
        platform: 'polymarket',
        title: 'Will Bitcoin reach $100,000 by end of 2024?',
        yesPrice: 0.25,
        noPrice: 0.75,
        volume: 1000000,
        liquidity: 50000,
      });
    });

    it('should skip resolved markets', async () => {
      const mockMarkets = {
        data: [
          {
            id: 'market-resolved',
            question: 'Resolved market',
            resolved: true,
            outcomePrices: ['1', '0'],
          },
          {
            id: 'market-active',
            question: 'Active market',
            resolved: false,
            outcomePrices: ['0.5', '0.5'],
            active: true,
            closed: false,
          },
        ],
      };

      mockDataClient.get.mockResolvedValueOnce(mockMarkets);

      const contracts = await platform.getAvailableContracts();

      expect(contracts).toHaveLength(1);
      expect(contracts[0].id).toBe('market-active');
    });
  });

  describe('placeOrder', () => {
    beforeEach(async () => {
      const config: BettingPlatformConfig = {
        name: 'polymarket',
        apiKey: 'test-api-key',
        apiSecret: 'test-api-secret',
        customConfig: {
          privateKey: 'test-private-key',
        },
      };
      await platform.initialize(config);
    });

    it('should place a market order', async () => {
      const order: Order = {
        contractId: 'market-123',
        platform: 'polymarket',
        side: 'yes',
        quantity: 100,
        orderType: 'market',
      };

      // Mock getContract call
      mockDataClient.get.mockResolvedValueOnce({
        data: {
          id: 'market-123',
          clobTokenIds: ['token-yes', 'token-no'],
          outcomePrices: ['0.3', '0.7'],
        },
      });

      // Mock order placement
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: {
          id: 'order-123',
          status: 'FILLED',
          filled_size: '100',
          average_price: '0.3',
          created_at: '2024-01-01T00:00:00Z',
        },
      });

      const result = await platform.placeOrder(order);

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/orders', {
        market: 'market-123',
        asset_id: 'token-yes',
        side: 'BUY',
        size: '100',
        price: '0.3',
        type: 'MARKET',
        client_order_id: expect.stringContaining('ancf_'),
        signature: 'mock-signature',
        address: '0x1234567890123456789012345678901234567890',
      });

      expect(result).toMatchObject({
        orderId: 'order-123',
        status: 'filled',
        filledQuantity: 100,
        averagePrice: 0.3,
      });
    });

    it('should place a limit order', async () => {
      const order: Order = {
        contractId: 'market-123',
        platform: 'polymarket',
        side: 'no',
        quantity: 50,
        orderType: 'limit',
        limitPrice: 0.65,
      };

      // Mock getContract call
      mockDataClient.get.mockResolvedValueOnce({
        data: {
          id: 'market-123',
          clobTokenIds: ['token-yes', 'token-no'],
          outcomePrices: ['0.3', '0.7'],
        },
      });

      // Mock order placement
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: {
          id: 'order-456',
          status: 'OPEN',
          filled_size: '0',
          created_at: '2024-01-01T00:00:00Z',
        },
      });

      const result = await platform.placeOrder(order);

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/orders', {
        market: 'market-123',
        asset_id: 'token-no',
        side: 'BUY',
        size: '50',
        price: '0.65',
        type: 'LIMIT',
        client_order_id: expect.stringContaining('ancf_'),
        signature: 'mock-signature',
        address: '0x1234567890123456789012345678901234567890',
      });

      expect(result.status).toBe('pending');
    });

    it('should throw error without credentials', async () => {
      const platformReadOnly = new PolymarketPlatform();
      await platformReadOnly.initialize({ name: 'polymarket' });

      const order: Order = {
        contractId: 'market-123',
        platform: 'polymarket',
        side: 'yes',
        quantity: 100,
        orderType: 'market',
      };

      await expect(platformReadOnly.placeOrder(order)).rejects.toThrow(
        'Polymarket trading requires API credentials and private key',
      );
    });
  });

  describe('getPositions', () => {
    it('should fetch and convert positions', async () => {
      const config: BettingPlatformConfig = {
        name: 'polymarket',
        apiKey: 'test-api-key',
        apiSecret: 'test-api-secret',
        customConfig: {
          privateKey: 'test-private-key',
        },
      };
      await platform.initialize(config);

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [
          {
            market: 'market-123',
            asset_id: 'token-yes',
            position: '100',
            average_price: '0.25',
            realized_pnl: '10',
            unrealized_pnl: '15',
          },
        ],
      });

      // Mock getContract call
      mockDataClient.get.mockResolvedValueOnce({
        data: {
          id: 'market-123',
          clobTokenIds: ['token-yes', 'token-no'],
          outcomePrices: ['0.3', '0.7'],
        },
      });

      const positions = await platform.getPositions();

      expect(positions).toHaveLength(1);
      expect(positions[0]).toMatchObject({
        contractId: 'market-123',
        platform: 'polymarket',
        quantity: 100,
        side: 'yes',
        averagePrice: 0.25,
        currentPrice: 0.3,
        unrealizedPnl: 15,
        realizedPnl: 10,
      });
    });

    it('should return empty array without credentials', async () => {
      const config: BettingPlatformConfig = {
        name: 'polymarket',
      };
      await platform.initialize(config);

      const positions = await platform.getPositions();

      expect(positions).toEqual([]);
    });
  });

  describe('getMarketResolution', () => {
    beforeEach(async () => {
      const config: BettingPlatformConfig = {
        name: 'polymarket',
      };
      await platform.initialize(config);
    });

    it('should return resolution for resolved market', async () => {
      mockDataClient.get.mockResolvedValueOnce({
        data: {
          id: 'market-123',
          resolved: true,
          resolvedOutcome: 'Yes',
          outcomes: ['Yes', 'No'],
        },
      });

      const resolution = await platform.getMarketResolution('market-123');

      expect(resolution).toMatchObject({
        contractId: 'market-123',
        resolved: true,
        outcome: 'yes',
        settlementPrice: 1,
      });
    });

    it('should return null for unresolved market', async () => {
      mockDataClient.get.mockResolvedValueOnce({
        data: {
          id: 'market-123',
          resolved: false,
        },
      });

      const resolution = await platform.getMarketResolution('market-123');

      expect(resolution).toBeNull();
    });
  });

  describe('isHealthy', () => {
    beforeEach(async () => {
      const config: BettingPlatformConfig = {
        name: 'polymarket',
      };
      await platform.initialize(config);
    });

    it('should return true when API is accessible', async () => {
      mockDataClient.get.mockResolvedValueOnce({
        status: 200,
        data: [],
      });

      const healthy = await platform.isHealthy();

      expect(healthy).toBe(true);
    });

    it('should return false when API is not accessible', async () => {
      mockDataClient.get.mockRejectedValueOnce(new Error('Network error'));

      const healthy = await platform.isHealthy();

      expect(healthy).toBe(false);
    });
  });

  describe('PolymarketPlatformPlugin', () => {
    it('should create a new instance', () => {
      const config: BettingPlatformConfig = {
        name: 'polymarket',
      };

      const instance = PolymarketPlatformPlugin.create(config);

      expect(instance).toBeInstanceOf(PolymarketPlatform);
    });
  });
});
