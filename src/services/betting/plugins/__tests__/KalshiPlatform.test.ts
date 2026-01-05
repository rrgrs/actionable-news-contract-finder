import { KalshiPlatform, KalshiPlatformPlugin } from '../KalshiPlatform';
import axios from 'axios';
import * as jwt from 'jsonwebtoken';
import { BettingPlatformConfig } from '../../../../types';

jest.mock('axios');
jest.mock('jsonwebtoken');
jest.mock('fs', () => ({
  readFileSync: jest.fn().mockReturnValue('fake-private-key'),
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('KalshiPlatform', () => {
  let platform: KalshiPlatform;
  let mockAxiosInstance: {
    post: jest.Mock;
    get: jest.Mock;
    delete: jest.Mock;
    defaults: {
      headers: {
        common: Record<string, string>;
      };
    };
    interceptors: {
      request: {
        use: jest.Mock;
      };
    };
  };

  beforeEach(() => {
    platform = new KalshiPlatform();

    mockAxiosInstance = {
      post: jest.fn(),
      get: jest.fn(),
      delete: jest.fn(),
      defaults: {
        headers: {
          common: {},
        },
      },
      interceptors: {
        request: {
          use: jest.fn(),
        },
      },
    };

    mockedAxios.create = jest.fn().mockReturnValue(mockAxiosInstance);
    (jwt.sign as jest.Mock).mockReturnValue('fake-jwt-token');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('initialize', () => {
    it('should initialize with API credentials using JWT authentication', async () => {
      const config: BettingPlatformConfig = {
        name: 'kalshi',
        customConfig: {
          apiKeyId: 'test-api-key-id',
          privateKeyPath: '/path/to/private-key.pem',
        },
      };

      await platform.initialize(config);

      expect(mockedAxios.create).toHaveBeenCalledWith({
        baseURL: 'https://api.elections.kalshi.com/trade-api/v2',
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: 60000,
      });
    });

    it('should use demo mode when enabled', async () => {
      const config: BettingPlatformConfig = {
        name: 'kalshi',
        customConfig: {
          apiKeyId: 'test-api-key-id',
          privateKeyPath: '/path/to/private-key.pem',
          demoMode: true,
        },
      };

      await platform.initialize(config);

      expect(mockedAxios.create).toHaveBeenCalledWith({
        baseURL: 'https://demo-api.kalshi.co/trade-api/v2',
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: 60000,
      });
    });

    it('should throw error if credentials are missing', async () => {
      const config: BettingPlatformConfig = {
        name: 'kalshi',
      };

      await expect(platform.initialize(config)).rejects.toThrow(
        'Kalshi API credentials not provided',
      );
    });

    it('should add request interceptor for JWT signing', async () => {
      const config: BettingPlatformConfig = {
        name: 'kalshi',
        customConfig: {
          apiKeyId: 'test-api-key-id',
          privateKeyPath: '/path/to/private-key.pem',
        },
      };

      await platform.initialize(config);

      expect(mockAxiosInstance.interceptors.request.use).toHaveBeenCalled();
    });
  });

  describe('getMarkets', () => {
    const config: BettingPlatformConfig = {
      name: 'kalshi',
      customConfig: {
        apiKeyId: 'test-api-key-id',
        privateKeyPath: '/path/to/private-key.pem',
      },
    };

    beforeEach(async () => {
      await platform.initialize(config);
    });

    it('should fetch events and markets separately and combine them', async () => {
      const mockEvents = [
        {
          event_ticker: 'KXTEST',
          series_ticker: 'KXSERIES',
          title: 'Test Event',
          sub_title: 'Test subtitle',
          category: 'Technology',
          mutually_exclusive: true,
        },
      ];

      const mockMarkets = [
        {
          ticker: 'KXTEST-YES',
          event_ticker: 'KXTEST',
          title: 'Test Market',
          yes_sub_title: 'Yes',
          no_sub_title: 'No',
          status: 'active',
          open_time: '2024-01-01T00:00:00Z',
          expiration_time: '2025-12-31T00:00:00Z',
          yes_ask: 65,
          no_ask: 35,
          volume: 10000,
          liquidity: 5000,
        },
      ];

      // Both endpoints called in parallel
      mockAxiosInstance.get.mockImplementation((url: string) => {
        if (url === '/events') {
          return Promise.resolve({ data: { events: mockEvents, cursor: null } });
        }
        if (url === '/markets') {
          return Promise.resolve({ data: { markets: mockMarkets, cursor: null } });
        }
        return Promise.reject(new Error('Unknown endpoint'));
      });

      const markets = await platform.getMarkets();

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/events', {
        params: { status: 'open', limit: 200, cursor: undefined },
      });
      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/markets', {
        params: { status: 'open', limit: 200, cursor: undefined },
      });

      expect(markets).toHaveLength(1);
      expect(markets[0].id).toBe('KXTEST');
      expect(markets[0].platform).toBe('kalshi');
      expect(markets[0].title).toBe('Test Event');
      expect(markets[0].contracts).toHaveLength(1);
      expect(markets[0].contracts[0].id).toBe('KXTEST-YES');
      expect(markets[0].contracts[0].yesPrice).toBe(0.65);
    });

    it('should skip markets without matching events', async () => {
      const mockEvents = [
        {
          event_ticker: 'KXOTHER',
          title: 'Other Event',
        },
      ];

      const mockMarkets = [
        {
          ticker: 'KXTEST-YES',
          event_ticker: 'KXTEST', // No matching event
          title: 'Test Market',
          status: 'active',
          open_time: '2024-01-01T00:00:00Z',
          expiration_time: '2025-12-31T00:00:00Z',
          yes_ask: 50,
          no_ask: 50,
        },
      ];

      mockAxiosInstance.get.mockImplementation((url: string) => {
        if (url === '/events') {
          return Promise.resolve({ data: { events: mockEvents, cursor: null } });
        }
        if (url === '/markets') {
          return Promise.resolve({ data: { markets: mockMarkets, cursor: null } });
        }
        return Promise.reject(new Error('Unknown endpoint'));
      });

      const markets = await platform.getMarkets();

      expect(markets).toHaveLength(0);
    });

    it('should handle pagination for both endpoints', async () => {
      let eventsCallCount = 0;
      let marketsCallCount = 0;

      mockAxiosInstance.get.mockImplementation((url: string) => {
        if (url === '/events') {
          eventsCallCount++;
          if (eventsCallCount === 1) {
            return Promise.resolve({
              data: {
                events: [{ event_ticker: 'KX1', title: 'Event 1' }],
                cursor: 'events-next',
              },
            });
          }
          return Promise.resolve({
            data: {
              events: [{ event_ticker: 'KX2', title: 'Event 2' }],
              cursor: null,
            },
          });
        }
        if (url === '/markets') {
          marketsCallCount++;
          if (marketsCallCount === 1) {
            return Promise.resolve({
              data: {
                markets: [
                  {
                    ticker: 'KX1-YES',
                    event_ticker: 'KX1',
                    status: 'active',
                    open_time: '2024-01-01T00:00:00Z',
                    expiration_time: '2025-12-31T00:00:00Z',
                    yes_ask: 50,
                    no_ask: 50,
                  },
                ],
                cursor: 'markets-next',
              },
            });
          }
          return Promise.resolve({
            data: {
              markets: [
                {
                  ticker: 'KX2-YES',
                  event_ticker: 'KX2',
                  status: 'active',
                  open_time: '2024-01-01T00:00:00Z',
                  expiration_time: '2025-12-31T00:00:00Z',
                  yes_ask: 60,
                  no_ask: 40,
                },
              ],
              cursor: null,
            },
          });
        }
        return Promise.reject(new Error('Unknown endpoint'));
      });

      const markets = await platform.getMarkets();

      expect(eventsCallCount).toBe(2);
      expect(marketsCallCount).toBe(2);
      expect(markets).toHaveLength(2);
    });
  });

  describe('isHealthy', () => {
    it('should return true when exchange is active', async () => {
      const config: BettingPlatformConfig = {
        name: 'kalshi',
        customConfig: {
          apiKeyId: 'test-api-key-id',
          privateKeyPath: '/path/to/private-key.pem',
        },
      };

      await platform.initialize(config);

      mockAxiosInstance.get.mockResolvedValue({
        data: { trading_active: true },
      });

      const healthy = await platform.isHealthy();
      expect(healthy).toBe(true);
    });

    it('should return false when exchange is not active', async () => {
      const config: BettingPlatformConfig = {
        name: 'kalshi',
        customConfig: {
          apiKeyId: 'test-api-key-id',
          privateKeyPath: '/path/to/private-key.pem',
        },
      };

      await platform.initialize(config);

      mockAxiosInstance.get.mockResolvedValue({
        data: { trading_active: false },
      });

      const healthy = await platform.isHealthy();
      expect(healthy).toBe(false);
    });

    it('should return false on error', async () => {
      const config: BettingPlatformConfig = {
        name: 'kalshi',
        customConfig: {
          apiKeyId: 'test-api-key-id',
          privateKeyPath: '/path/to/private-key.pem',
        },
      };

      await platform.initialize(config);

      mockAxiosInstance.get.mockRejectedValue(new Error('Network error'));

      const healthy = await platform.isHealthy();
      expect(healthy).toBe(false);
    });
  });

  describe('KalshiPlatformPlugin', () => {
    it('should create a KalshiPlatform instance', () => {
      const config: BettingPlatformConfig = {
        name: 'kalshi',
      };

      const instance = KalshiPlatformPlugin.create(config);
      expect(instance).toBeInstanceOf(KalshiPlatform);
    });
  });
});
