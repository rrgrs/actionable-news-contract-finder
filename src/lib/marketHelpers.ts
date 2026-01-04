import { Market as PrismaMarket, Contract as PrismaContract } from '@prisma/client';
import { Market, ContractOutcome, MarketWithContracts, Contract } from '../types';

/**
 * Helper functions for Market and Contract JSON field operations
 */

/**
 * Format an embedding vector for pgvector storage
 * Returns the vector in pgvector format: [0.1, 0.2, ...]
 */
export function formatVectorForPgvector(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

/**
 * Get metadata as an object from a Contract
 */
export function getMetadataObject(record: PrismaContract): Record<string, unknown> {
  if (!record.metadata) {
    return {};
  }
  try {
    return JSON.parse(record.metadata);
  } catch {
    return {};
  }
}

/**
 * Serialize metadata object to JSON string
 */
export function serializeMetadata(metadata: Record<string, unknown>): string {
  return JSON.stringify(metadata);
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
    id: market.id.toString(),
    platform: market.platform,
    eventTicker: market.eventTicker,
    seriesTicker: market.seriesTicker || undefined,
    title: market.title,
    url: market.url,
    category: market.category || undefined,
    endDate: market.endDate || undefined,
    metadata: {},
  };
}

/**
 * Convert Prisma Contract to API ContractOutcome type
 * Platform is passed from the parent Market since Contract no longer stores it
 */
export function prismaContractToOutcome(
  contract: PrismaContract,
  platform: string,
): ContractOutcome {
  return {
    id: contract.id.toString(),
    contractTicker: contract.contractTicker,
    platform,
    title: contract.title,
    yesPrice: contract.yesPrice,
    noPrice: contract.noPrice,
    volume: contract.volume,
    liquidity: contract.liquidity,
    metadata: getMetadataObject(contract),
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
    contracts: market.contracts.map((c) => prismaContractToOutcome(c, market.platform)),
  };
}

/**
 * Extract series ticker from event ticker
 * e.g., 'KXBTC' from 'KXBTC-26JAN0109'
 */
export function extractSeriesTicker(eventTicker: string): string {
  const match = eventTicker.match(/^([A-Z]+)(?:-\d{2}[A-Z]{3}|-\d+)/i);
  return match ? match[1].toUpperCase() : eventTicker.split('-')[0].toUpperCase();
}

/**
 * Extract event ticker from a flat Contract (from platform API)
 */
export function extractEventTicker(contract: Contract): string | null {
  const metadata = contract.metadata || {};
  // Kalshi stores eventTicker in metadata
  if (metadata.eventTicker) {
    return String(metadata.eventTicker);
  }
  // Fall back to extracting from contract ID
  // Format: EVENTID-DATE-STRIKE (e.g., KXBTC-26JAN0109-T97749.99)
  const parts = contract.id.split('-');
  if (parts.length >= 2) {
    // Return first two parts as event ticker
    return `${parts[0]}-${parts[1]}`;
  }
  return null;
}

/**
 * Group flat contracts by event ticker
 * Returns a map of eventTicker -> contracts
 */
export function groupContractsByEvent(contracts: Contract[]): Map<string, Contract[]> {
  const groups = new Map<string, Contract[]>();

  for (const contract of contracts) {
    const eventTicker = extractEventTicker(contract);
    if (!eventTicker) {
      // Put ungrouped contracts under a special key
      const key = `__ungrouped__${contract.id}`;
      groups.set(key, [contract]);
      continue;
    }

    const existing = groups.get(eventTicker) || [];
    existing.push(contract);
    groups.set(eventTicker, existing);
  }

  return groups;
}

/**
 * Find the longest common prefix among an array of strings
 */
function findLongestCommonPrefix(strings: string[]): string {
  if (strings.length === 0) {
    return '';
  }
  if (strings.length === 1) {
    return strings[0];
  }

  // Sort to compare only first and last (they'll be most different)
  const sorted = [...strings].sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  let prefixLength = 0;
  while (
    prefixLength < first.length &&
    prefixLength < last.length &&
    first[prefixLength] === last[prefixLength]
  ) {
    prefixLength++;
  }

  return first.substring(0, prefixLength);
}

/**
 * Clean up a market title by removing trailing partial words and separators
 * e.g., "Minnesota at Atlanta: Double Doubles: " -> "Minnesota at Atlanta: Double Doubles"
 * e.g., "Orlando at Indiana: Double Doubles: Pa" -> "Orlando at Indiana: Double Doubles"
 * But keeps complete words: "Market Title - Option " -> "Market Title - Option"
 */
function cleanMarketTitle(title: string): string {
  let cleaned = title;

  // If the title ends with a partial word (no trailing space before trim),
  // remove that partial word back to the last separator
  // This handles cases like "Market: Pa" where "Pa" is a partial match of "Paolo"/"Pascal"
  // But keeps "Market - Option " which has a complete word "Option" followed by space
  if (!title.endsWith(' ')) {
    const lastSeparatorMatch = cleaned.match(/^(.*[:|\-,]\s*)[A-Za-z0-9]+$/);
    if (lastSeparatorMatch) {
      cleaned = lastSeparatorMatch[1];
    }
  }

  // Remove trailing separators and whitespace
  return cleaned.replace(/[\s:,-]+$/, '').trim();
}

/**
 * Derive market-level title from a group of contracts
 * First checks if contracts have a shared marketTitle in metadata,
 * otherwise finds the common prefix across all contract titles
 */
export function deriveMarketTitle(contracts: Contract[]): string {
  if (contracts.length === 0) {
    return 'Unknown Market';
  }

  if (contracts.length === 1) {
    // Check for marketTitle in metadata first
    const marketTitle = contracts[0].metadata?.marketTitle;
    if (typeof marketTitle === 'string' && marketTitle.length > 0) {
      return marketTitle;
    }
    return contracts[0].title;
  }

  // Check if all contracts share the same marketTitle in metadata
  const marketTitles = contracts
    .map((c) => c.metadata?.marketTitle)
    .filter((t): t is string => typeof t === 'string' && t.length > 0);

  if (marketTitles.length > 0) {
    // Use the most common marketTitle (they should all be the same)
    const titleCounts = new Map<string, number>();
    for (const title of marketTitles) {
      titleCounts.set(title, (titleCounts.get(title) || 0) + 1);
    }

    // Find the most common title
    let mostCommon = '';
    let maxCount = 0;
    for (const [title, count] of titleCounts) {
      if (count > maxCount) {
        mostCommon = title;
        maxCount = count;
      }
    }

    if (mostCommon.length > 0) {
      return mostCommon;
    }
  }

  // Fallback: find common prefix
  const titles = contracts.map((c) => c.title);
  const commonPrefix = findLongestCommonPrefix(titles);

  // If we found a meaningful common prefix, clean it up and use it
  if (commonPrefix.length > 0) {
    const cleanedTitle = cleanMarketTitle(commonPrefix);
    // Only use the common prefix if it's substantial (at least 10 chars)
    // Otherwise fall back to the first contract's title
    if (cleanedTitle.length >= 10) {
      return cleanedTitle;
    }
  }

  // Fallback: use first contract's title
  return contracts[0].title;
}

/**
 * Aggregate volume across all contracts in a market
 */
export function aggregateVolume(contracts: Contract[]): number {
  return contracts.reduce((sum, c) => sum + c.volume, 0);
}

/**
 * Aggregate liquidity across all contracts in a market
 */
export function aggregateLiquidity(contracts: Contract[]): number {
  return contracts.reduce((sum, c) => sum + c.liquidity, 0);
}
