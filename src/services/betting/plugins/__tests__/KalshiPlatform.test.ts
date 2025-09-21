import { KalshiPlatform, KalshiPlatformPlugin } from '../KalshiPlatform';
import axios from 'axios';
import { BettingPlatformConfig, Order } from '../../../../types';

jest.mock('axios');
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
    };

    mockedAxios.create = jest.fn().mockReturnValue(mockAxiosInstance);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('initialize', () => {
    it('should initialize with API credentials and authenticate', async () => {
      const config: BettingPlatformConfig = {
        name: 'kalshi',
        apiKey: 'test-email@example.com',
        apiSecret: 'test-password',
      };

      mockAxiosInstance.post.mockResolvedValueOnce({
        data: {
          token: 'test-token',
          member_id: 'test-member-id',
        },
      });

      await platform.initialize(config);

      expect(mockedAxios.create).toHaveBeenCalledWith({
        baseURL: 'https://trading-api.kalshi.com/trade-api/v2',
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      });

      expect(mockAxiosInstance.post).toHaveBeenCalledWith('/login', {
        email: 'test-email@example.com',
        password: 'test-password',
      });

      expect(mockAxiosInstance.defaults.headers.common['Authorization']).toBe('Bearer test-token');
    });

    it('should use demo mode when configured', async () => {
      const config: BettingPlatformConfig = {
        name: 'kalshi',
        apiKey: 'test-email@example.com',
        apiSecret: 'test-password',
        customConfig: {
          demoMode: true,
        },
      };

      mockAxiosInstance.post.mockResolvedValueOnce({
        data: {
          token: 'test-token',
          member_id: 'test-member-id',
        },
      });

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
        apiKey: 'test-email@example.com',
        apiSecret: 'test-password',
      };

      mockAxiosInstance.post.mockResolvedValueOnce({
        data: {
          token: 'test-token',
          member_id: 'test-member-id',
        },
      });

      await platform.initialize(config);
    });

    it('should fetch and convert available contracts', async () => {
      const mockEvents = {
        data: {
          events: [
            {
              event_ticker: 'FEDRATE',
              series_ticker: 'FEDRATE-24',
              title: 'Federal Reserve Rate Decision',
              category: 'Economics',
              markets: [
                {
                  ticker: 'FEDRATE-24-HIKE',
                  event_ticker: 'FEDRATE',
                  title: 'Fed raises rates in December 2024',
                  subtitle: 'Will the Fed raise rates?',
                  yes_sub_title: 'Yes',
                  no_sub_title: 'No',
                  status: 'open',
                  yes_ask: 3500, // 35 cents
                  no_ask: 6500, // 65 cents
                  yes_bid: 3000,
                  no_bid: 7000,
                  last_price: 3250,
                  volume: 50000,
                  volume_24h: 10000,
                  liquidity: 100000,
                  open_interest: 5000,
                  close_time: '2024-12-31T23:59:59Z',
                  expiration_time: '2025-01-01T00:00:00Z',
                  market_type: 'binary',
                },
              ],
            },
          ],
        },
      };

      mockAxiosInstance.get.mockResolvedValueOnce(mockEvents);

      const contracts = await platform.getAvailableContracts();

      expect(contracts).toHaveLength(1);
      expect(contracts[0]).toMatchObject({
        id: 'FEDRATE-24-HIKE',
        platform: 'kalshi',
        title: 'Fed raises rates in December 2024',
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
        apiKey: 'test-email@example.com',
        apiSecret: 'test-password',
      };

      mockAxiosInstance.post.mockResolvedValueOnce({
        data: {
          token: 'test-token',
          member_id: 'test-member-id',
        },
      });

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
        apiKey: 'test-email@example.com',
        apiSecret: 'test-password',
      };

      mockAxiosInstance.post.mockResolvedValueOnce({
        data: {
          token: 'test-token',
          member_id: 'test-member-id',
        },
      });

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
              yes_ask: 4000,
              no_ask: 6000,
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
        apiKey: 'test-email@example.com',
        apiSecret: 'test-password',
      };

      mockAxiosInstance.post.mockResolvedValueOnce({
        data: {
          token: 'test-token',
          member_id: 'test-member-id',
        },
      });

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
        apiKey: 'test-email@example.com',
        apiSecret: 'test-password',
      };

      mockAxiosInstance.post.mockResolvedValueOnce({
        data: {
          token: 'test-token',
          member_id: 'test-member-id',
        },
      });

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
