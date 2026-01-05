import { PolymarketPlatform, PolymarketPlatformPlugin } from '../PolymarketPlatform';
import axios from 'axios';
import { ethers } from 'ethers';
import { BettingPlatformConfig } from '../../../../types';

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
    (mockedEthers.Wallet as unknown as jest.Mock).mockImplementation(() => ({
      address: '0x1234567890abcdef1234567890abcdef12345678',
    }));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('initialize', () => {
    it('should initialize in read-only mode without credentials', async () => {
      const config: BettingPlatformConfig = {
        name: 'polymarket',
      };

      await platform.initialize(config);

      expect(mockedAxios.create).toHaveBeenCalledTimes(2);
    });

    it('should initialize with API credentials', async () => {
      const config: BettingPlatformConfig = {
        name: 'polymarket',
        apiKey: 'test-api-key',
        apiSecret: 'test-api-secret',
        customConfig: {
          privateKey: '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        },
      };

      await platform.initialize(config);

      expect(mockedAxios.create).toHaveBeenCalledTimes(2);
    });

    it('should throw if private key is missing but API credentials provided', async () => {
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

  describe('getMarkets', () => {
    beforeEach(async () => {
      const config: BettingPlatformConfig = {
        name: 'polymarket',
      };
      await platform.initialize(config);
    });

    it('should fetch and convert markets correctly', async () => {
      const mockMarkets = [
        {
          id: 'market-1',
          question: 'Will Bitcoin reach $100k?',
          conditionId: 'cond-1',
          slug: 'bitcoin-100k',
          resolutionSource: 'https://example.com',
          endDate: '2025-12-31T00:00:00Z',
          liquidity: '50000',
          volume: '100000',
          volume24hr: '5000',
          clobTokenIds: ['token-1'],
          outcomes: ['Yes', 'No'],
          outcomePrices: ['0.65', '0.35'],
          minimum_order_size: 1,
          minimum_tick_size: 0.01,
          description: 'Test description',
          tags: ['crypto'],
          active: true,
          closed: false,
          archived: false,
          accepting_orders: true,
          resolved: false,
        },
      ];

      mockDataClient.get.mockResolvedValue({ data: mockMarkets });

      const markets = await platform.getMarkets();

      expect(markets).toHaveLength(1);
      expect(markets[0].id).toBe('market-1');
      expect(markets[0].platform).toBe('polymarket');
      expect(markets[0].title).toBe('Will Bitcoin reach $100k?');
      expect(markets[0].url).toBe('https://polymarket.com/event/bitcoin-100k');
      expect(markets[0].contracts).toHaveLength(1);
      expect(markets[0].contracts[0].yesPrice).toBe(0.65);
      expect(markets[0].contracts[0].noPrice).toBe(0.35);
    });

    it('should filter out resolved markets', async () => {
      const mockMarkets = [
        {
          id: 'market-1',
          question: 'Active Market',
          slug: 'active',
          endDate: '2025-12-31T00:00:00Z',
          liquidity: '50000',
          volume: '100000',
          outcomes: ['Yes', 'No'],
          outcomePrices: ['0.65', '0.35'],
          tags: ['test'],
          resolved: false,
        },
        {
          id: 'market-2',
          question: 'Resolved Market',
          slug: 'resolved',
          endDate: '2024-01-01T00:00:00Z',
          liquidity: '0',
          volume: '200000',
          outcomes: ['Yes', 'No'],
          outcomePrices: ['1', '0'],
          tags: ['test'],
          resolved: true,
        },
      ];

      mockDataClient.get.mockResolvedValue({ data: mockMarkets });

      const markets = await platform.getMarkets();

      expect(markets).toHaveLength(1);
      expect(markets[0].id).toBe('market-1');
    });

    it('should call the data API with correct parameters', async () => {
      mockDataClient.get.mockResolvedValue({ data: [] });

      await platform.getMarkets();

      expect(mockDataClient.get).toHaveBeenCalledWith('/markets', {
        params: {
          active: true,
          closed: false,
          limit: 100,
          order: 'volume24hr',
          ascending: false,
        },
      });
    });
  });

  describe('isHealthy', () => {
    beforeEach(async () => {
      const config: BettingPlatformConfig = {
        name: 'polymarket',
      };
      await platform.initialize(config);
    });

    it('should return true when API responds with valid data', async () => {
      mockDataClient.get.mockResolvedValue({
        status: 200,
        data: [],
      });

      const healthy = await platform.isHealthy();
      expect(healthy).toBe(true);
    });

    it('should return false when API fails', async () => {
      mockDataClient.get.mockRejectedValue(new Error('Network error'));

      const healthy = await platform.isHealthy();
      expect(healthy).toBe(false);
    });
  });

  describe('PolymarketPlatformPlugin', () => {
    it('should create a PolymarketPlatform instance', () => {
      const config: BettingPlatformConfig = {
        name: 'polymarket',
      };

      const instance = PolymarketPlatformPlugin.create(config);
      expect(instance).toBeInstanceOf(PolymarketPlatform);
    });
  });
});
