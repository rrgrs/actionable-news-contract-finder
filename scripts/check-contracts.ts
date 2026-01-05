import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();

async function main() {
  // Markets with matches but no active contracts
  const marketsWithMatchesNoContracts = await prisma.market.findMany({
    where: {
      newsMatches: { some: {} },
      contracts: { none: { isActive: true } },
    },
    select: {
      id: true,
      eventTicker: true,
      title: true,
      isActive: true,
      platform: true,
      _count: {
        select: {
          newsMatches: true,
          contracts: true,
        },
      },
    },
    take: 20,
  });

  console.log('\n--- Markets with matches but no active contracts ---');
  console.log('Sample count:', marketsWithMatchesNoContracts.length);
  marketsWithMatchesNoContracts.forEach((m) => {
    console.log(`  - ID: ${m.id}, Ticker: ${m.eventTicker}, Active: ${m.isActive}`);
    console.log(`    Title: ${m.title.substring(0, 60)}`);
    console.log(`    Matches: ${m._count.newsMatches}, Contracts: ${m._count.contracts}`);
  });

  // Check total markets with/without contracts
  const marketsWithContracts = await prisma.market.count({
    where: { contracts: { some: { isActive: true } } },
  });
  const marketsWithoutContracts = await prisma.market.count({
    where: { contracts: { none: { isActive: true } } },
  });
  console.log('\n--- Market contract stats ---');
  console.log('Markets with active contracts:', marketsWithContracts);
  console.log('Markets without active contracts:', marketsWithoutContracts);

  // Check contracts by active status
  const contractStats = await prisma.contract.groupBy({
    by: ['isActive'],
    _count: true,
  });
  console.log('\n--- Contract active stats ---');
  console.log(contractStats);

  // Check if there are inactive contracts on markets with matches
  const inactiveContractsOnMatchedMarkets = await prisma.contract.count({
    where: {
      isActive: false,
      market: {
        newsMatches: { some: {} },
      },
    },
  });
  console.log('\n--- Inactive contracts on markets with matches ---');
  console.log('Count:', inactiveContractsOnMatchedMarkets);

  await prisma.$disconnect();
}

main().catch(console.error);
