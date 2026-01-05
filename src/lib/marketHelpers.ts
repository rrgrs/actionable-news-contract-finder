import { Market as PrismaMarket, Contract as PrismaContract } from '@prisma/client';
import { Market, MarketWithContracts, Contract } from '../types';

/**
 * Helper functions for Market and Contract operations
 */

/**
 * Format an embedding vector for pgvector storage
 * Returns the vector in pgvector format: [0.1, 0.2, ...]
 */
export function formatVectorForPgvector(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

/**
 * Get text for embedding generation from a Market
 */
export function getTextForEmbedding(market: PrismaMarket): string {
  const parts = [market.title];
  if (market.category) {
    parts.push(`Category: ${market.category}`);
  }
  return parts.join('. ');
}

/**
 * Convert Prisma Market to API Market type
 */
export function prismaMarketToMarket(market: PrismaMarket): Market {
  return {
    id: market.eventTicker,
    platform: market.platform,
    seriesTicker: market.seriesTicker || undefined,
    title: market.title,
    url: market.url,
    category: market.category || undefined,
    endDate: market.endDate || undefined,
  };
}

/**
 * Convert Prisma Contract to API Contract type
 */
export function prismaContractToContract(contract: PrismaContract): Contract {
  return {
    id: contract.contractTicker,
    title: contract.title,
    yesPrice: contract.yesPrice,
    noPrice: contract.noPrice,
    volume: contract.volume,
    liquidity: contract.liquidity,
  };
}

/**
 * Convert Prisma Market with included contracts to MarketWithContracts
 */
export function prismaMarketWithContractsToMarketWithContracts(
  market: PrismaMarket & { contracts: PrismaContract[] },
): MarketWithContracts {
  return {
    ...prismaMarketToMarket(market),
    contracts: market.contracts.map(prismaContractToContract),
  };
}
