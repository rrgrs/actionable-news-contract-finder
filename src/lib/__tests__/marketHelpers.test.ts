import { Market as PrismaMarket, Contract as PrismaContract } from '@prisma/client';
import {
  formatVectorForPgvector,
  getTextForEmbedding,
  prismaMarketToMarket,
  prismaContractToContract,
  prismaMarketWithContractsToMarketWithContracts,
} from '../marketHelpers';

describe('marketHelpers', () => {
  describe('formatVectorForPgvector', () => {
    it('should format a vector array into pgvector string format', () => {
      const vector = [0.1, 0.2, 0.3];
      expect(formatVectorForPgvector(vector)).toBe('[0.1,0.2,0.3]');
    });

    it('should handle empty arrays', () => {
      expect(formatVectorForPgvector([])).toBe('[]');
    });

    it('should handle single element arrays', () => {
      expect(formatVectorForPgvector([0.5])).toBe('[0.5]');
    });
  });

  describe('getTextForEmbedding', () => {
    it('should return title when no category', () => {
      const market = {
        id: 1,
        platform: 'kalshi',
        eventTicker: 'TEST-123',
        seriesTicker: null,
        title: 'Will it rain tomorrow?',
        url: 'https://example.com',
        category: null,
        endDate: null,
        isActive: true,
        embedding: null,
        embeddingUpdatedAt: null,
        lastSyncedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as PrismaMarket;

      expect(getTextForEmbedding(market)).toBe('Will it rain tomorrow?');
    });

    it('should include category when present', () => {
      const market = {
        id: 1,
        platform: 'kalshi',
        eventTicker: 'TEST-123',
        seriesTicker: null,
        title: 'Will it rain tomorrow?',
        url: 'https://example.com',
        category: 'Weather',
        endDate: null,
        isActive: true,
        embedding: null,
        embeddingUpdatedAt: null,
        lastSyncedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as PrismaMarket;

      expect(getTextForEmbedding(market)).toBe('Will it rain tomorrow?. Category: Weather');
    });
  });

  describe('prismaMarketToMarket', () => {
    it('should convert Prisma Market to API Market type', () => {
      const prismaMarket = {
        id: 1,
        platform: 'kalshi',
        eventTicker: 'KXTEST',
        seriesTicker: 'KXSERIES',
        title: 'Test Market',
        url: 'https://kalshi.com/events/KXTEST',
        category: 'Technology',
        endDate: new Date('2025-12-31'),
        isActive: true,
        embedding: null,
        embeddingUpdatedAt: null,
        lastSyncedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as PrismaMarket;

      const result = prismaMarketToMarket(prismaMarket);

      expect(result).toEqual({
        id: 'KXTEST',
        platform: 'kalshi',
        seriesTicker: 'KXSERIES',
        title: 'Test Market',
        url: 'https://kalshi.com/events/KXTEST',
        category: 'Technology',
        endDate: new Date('2025-12-31'),
      });
    });

    it('should handle null optional fields', () => {
      const prismaMarket = {
        id: 1,
        platform: 'kalshi',
        eventTicker: 'KXTEST',
        seriesTicker: null,
        title: 'Test Market',
        url: 'https://kalshi.com/events/KXTEST',
        category: null,
        endDate: null,
        isActive: true,
        embedding: null,
        embeddingUpdatedAt: null,
        lastSyncedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as PrismaMarket;

      const result = prismaMarketToMarket(prismaMarket);

      expect(result.seriesTicker).toBeUndefined();
      expect(result.category).toBeUndefined();
      expect(result.endDate).toBeUndefined();
    });
  });

  describe('prismaContractToContract', () => {
    it('should convert Prisma Contract to API Contract type', () => {
      const prismaContract = {
        id: 1,
        marketId: 1,
        contractTicker: 'KXTEST-YES',
        title: 'Yes',
        yesPrice: 0.65,
        noPrice: 0.35,
        volume: 10000,
        liquidity: 5000,
        isActive: true,
        lastSyncedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as PrismaContract;

      const result = prismaContractToContract(prismaContract);

      expect(result).toEqual({
        id: 'KXTEST-YES',
        title: 'Yes',
        yesPrice: 0.65,
        noPrice: 0.35,
        volume: 10000,
        liquidity: 5000,
      });
    });
  });

  describe('prismaMarketWithContractsToMarketWithContracts', () => {
    it('should convert Prisma Market with contracts to API MarketWithContracts type', () => {
      const prismaMarket = {
        id: 1,
        platform: 'kalshi',
        eventTicker: 'KXTEST',
        seriesTicker: null,
        title: 'Test Market',
        url: 'https://kalshi.com/events/KXTEST',
        category: 'Technology',
        endDate: new Date('2025-12-31'),
        isActive: true,
        embedding: null,
        embeddingUpdatedAt: null,
        lastSyncedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        contracts: [
          {
            id: 1,
            marketId: 1,
            contractTicker: 'KXTEST-YES',
            title: 'Yes',
            yesPrice: 0.65,
            noPrice: 0.35,
            volume: 10000,
            liquidity: 5000,
            isActive: true,
            lastSyncedAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
          } as PrismaContract,
        ],
      } as PrismaMarket & { contracts: PrismaContract[] };

      const result = prismaMarketWithContractsToMarketWithContracts(prismaMarket);

      expect(result.id).toBe('KXTEST');
      expect(result.platform).toBe('kalshi');
      expect(result.title).toBe('Test Market');
      expect(result.contracts).toHaveLength(1);
      expect(result.contracts[0].id).toBe('KXTEST-YES');
      expect(result.contracts[0].yesPrice).toBe(0.65);
    });
  });
});
