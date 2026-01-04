import { KalshiPlatform, KalshiPlatformPlugin } from '../KalshiPlatform';
import axios from 'axios';
import * as jwt from 'jsonwebtoken';
import { BettingPlatformConfig, Order } from '../../../../types';

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
  };

  beforeEach(() => {
    platform = new KalshiPlatform();

    // Mock axios instance
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
    } as unknown as typeof mockAxiosInstance;

    mockedAxios.create = jest.fn().mockReturnValue(mockAxiosInstance);

    // Mock jwt.sign to return a fake token
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

      // fs.readFileSync is mocked to return 'fake-private-key'
      // Default is live mode
      expect(mockedAxios.create).toHaveBeenCalledWith({
        baseURL: 'https://api.elections.kalshi.com/trade-api/v2',
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: 15000,
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
        timeout: 15000,
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
  });

  describe('getAvailableContracts', () => {
    beforeEach(async () => {
      const config: BettingPlatformConfig = {
        name: 'kalshi',
        customConfig: {
          apiKeyId: 'test-api-key-id',
          privateKeyPath: '/path/to/private-key.pem',
        },
      };

      await platform.initialize(config);
    });

    it('should fetch and convert available contracts', async () => {
      // Mock the events endpoint (for fetchAllEventTitles)
      const mockEventsResponse = {
        data: {
          events: [
            {
              event_ticker: 'FEDRATE',
              title: 'Federal Reserve Rate Decision',
            },
          ],
          cursor: null,
        },
      };

      // Mock the markets endpoint
      const mockMarketsResponse = {
        data: {
          markets: [
            {
              ticker: 'FEDRATE-24-HIKE',
              event_ticker: 'FEDRATE',
              title: 'Fed raises rates in December 2024',
              subtitle: 'Will the Fed raise rates?',
              yes_sub_title: 'Yes',
              no_sub_title: 'No',
              status: 'open',
              yes_ask: 35, // 35 cents = $0.35
              no_ask: 65, // 65 cents = $0.65
              yes_bid: 30,
              no_bid: 70,
              last_price: 32,
              volume: 50000,
              volume_24h: 10000,
              liquidity: 100000,
              open_interest: 5000,
              open_time: '2024-01-01T00:00:00Z',
              close_time: '2024-12-31T23:59:59Z',
              expiration_time: '2025-01-01T00:00:00Z',
              market_type: 'binary',
            },
          ],
          cursor: null,
        },
      };

      // First call is for events, second is for markets
      mockAxiosInstance.get
        .mockResolvedValueOnce(mockEventsResponse)
        .mockResolvedValueOnce(mockMarketsResponse);

      const contracts = await platform.getAvailableContracts();

      expect(contracts).toHaveLength(1);
      expect(contracts[0]).toMatchObject({
        id: 'FEDRATE-24-HIKE',
        platform: 'kalshi',
        title: 'Yes',
        yesPrice: 0.35,
        noPrice: 0.65,
        volume: 50000,
        liquidity: 100000,
      });
    });
  });

  describe('placeOrder', () => {
    beforeEach(async () => {
      const config: BettingPlatformConfig = {
        name: 'kalshi',
        customConfig: {
          apiKeyId: 'test-api-key-id',
          privateKeyPath: '/path/to/private-key.pem',
        },
      };

      await platform.initialize(config);
    });

    it('should place a market order', async () => {
      const order: Order = {
        contractId: 'FEDRATE-24-HIKE',
        platform: 'kalshi',
        side: 'yes',
        quantity: 10,
        orderType: 'market',
      };

      mockAxiosInstance.post.mockResolvedValueOnce({
        data: {
          order: {
            order_id: 'order-123',
            status: 'executed',
            count: 10,
            yes_price: 3500,
            created_time: '2024-01-01T00:00:00Z',
          },
        },
      });

      const result = await platform.placeOrder(order);

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/portfolio/orders', {
        ticker: 'FEDRATE-24-HIKE',
        client_order_id: expect.stringContaining('ancf_'),
        side: 'yes',
        action: 'buy',
        count: 10,
        type: 'market',
      });

      expect(result).toMatchObject({
        orderId: 'order-123',
        status: 'filled',
        filledQuantity: 10,
        averagePrice: 35,
      });
    });

    it('should place a limit order', async () => {
      const order: Order = {
        contractId: 'FEDRATE-24-HIKE',
        platform: 'kalshi',
        side: 'no',
        quantity: 5,
        orderType: 'limit',
        limitPrice: 0.7,
      };

      mockAxiosInstance.post.mockResolvedValueOnce({
        data: {
          order: {
            order_id: 'order-456',
            status: 'resting',
            count: 5,
            no_price: 7000,
            created_time: '2024-01-01T00:00:00Z',
          },
        },
      });

      const result = await platform.placeOrder(order);

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/portfolio/orders', {
        ticker: 'FEDRATE-24-HIKE',
        client_order_id: expect.stringContaining('ancf_'),
        side: 'no',
        action: 'buy',
        count: 5,
        type: 'limit',
        no_price: 70,
      });

      expect(result.status).toBe('pending');
    });
  });

  describe('getPositions', () => {
    beforeEach(async () => {
      const config: BettingPlatformConfig = {
        name: 'kalshi',
        customConfig: {
          apiKeyId: 'test-api-key-id',
          privateKeyPath: '/path/to/private-key.pem',
        },
      };

      await platform.initialize(config);
    });

    it('should fetch and convert positions', async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce({
          data: {
            market_positions: [
              {
                ticker: 'FEDRATE-24-HIKE',
                position: 100,
                market_exposure: 3500,
                realized_pnl: 500,
                total_traded: 35000,
                fees_paid: 50,
              },
            ],
          },
        })
        .mockResolvedValueOnce({
          data: {
            market: {
              ticker: 'FEDRATE-24-HIKE',
              event_ticker: 'FEDRATE',
              yes_ask: 40, // 40 cents = $0.40
              no_ask: 60, // 60 cents = $0.60
              status: 'open',
              title: 'Fed Rate Hike',
              subtitle: 'Will rates increase?',
              close_time: '2024-12-31T23:59:59Z',
              expiration_time: '2025-01-01T00:00:00Z',
            },
          },
        })
        .mockResolvedValueOnce({
          data: {
            events: [
              {
                event_ticker: 'FEDRATE',
                title: 'Federal Reserve Decision',
              },
            ],
          },
        });

      const positions = await platform.getPositions();

      expect(positions).toHaveLength(1);
      expect(positions[0]).toMatchObject({
        contractId: 'FEDRATE-24-HIKE',
        platform: 'kalshi',
        quantity: 100,
        side: 'yes',
        averagePrice: 3.5,
        currentPrice: 0.4,
        realizedPnl: 5,
      });
    });
  });

  describe('getBalance', () => {
    beforeEach(async () => {
      const config: BettingPlatformConfig = {
        name: 'kalshi',
        customConfig: {
          apiKeyId: 'test-api-key-id',
          privateKeyPath: '/path/to/private-key.pem',
        },
      };

      await platform.initialize(config);
    });

    it('should fetch account balance', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: {
          balance: 10000, // $100 in cents
        },
      });

      const balance = await platform.getBalance();

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/portfolio/balance');
      expect(balance).toBe(100);
    });
  });

  describe('isHealthy', () => {
    beforeEach(async () => {
      const config: BettingPlatformConfig = {
        name: 'kalshi',
        customConfig: {
          apiKeyId: 'test-api-key-id',
          privateKeyPath: '/path/to/private-key.pem',
        },
      };

      await platform.initialize(config);
    });

    it('should return true when exchange is active', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: {
          trading_active: true,
        },
      });

      const healthy = await platform.isHealthy();

      expect(healthy).toBe(true);
    });

    it('should return false when exchange is inactive', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: {
          trading_active: false,
        },
      });

      const healthy = await platform.isHealthy();

      expect(healthy).toBe(false);
    });
  });

  describe('KalshiPlatformPlugin', () => {
    it('should create a new instance', () => {
      const config: BettingPlatformConfig = {
        name: 'kalshi',
      };

      const instance = KalshiPlatformPlugin.create(config);

      expect(instance).toBeInstanceOf(KalshiPlatform);
    });
  });
});
