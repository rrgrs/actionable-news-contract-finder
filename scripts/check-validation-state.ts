import { PrismaClient, NewsStatus } from '@prisma/client';
import * as dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();

async function main() {
  // Count matches by validation status
  const matchStats = await prisma.newsMarketMatch.groupBy({
    by: ['isValidated'],
    _count: true,
  });
  console.log('\n--- Match Validation Stats ---');
  console.log(matchStats);

  // Count articles by status
  const articleStats = await prisma.newsArticle.groupBy({
    by: ['status'],
    _count: true,
  });
  console.log('\n--- Article Status Stats ---');
  console.log(articleStats);

  // Find MATCHED articles with unvalidated matches
  const matchedWithUnvalidated = await prisma.newsArticle.count({
    where: {
      status: NewsStatus.MATCHED,
      marketMatches: {
        some: { isValidated: false },
      },
    },
  });
  console.log('\n--- MATCHED articles with unvalidated matches ---');
  console.log('Count:', matchedWithUnvalidated);

  // Check if there are articles NOT in MATCHED status but with unvalidated matches
  const otherWithUnvalidated = await prisma.newsArticle.findMany({
    where: {
      status: { not: NewsStatus.MATCHED },
      marketMatches: {
        some: { isValidated: false },
      },
    },
    select: {
      id: true,
      status: true,
      title: true,
      _count: {
        select: { marketMatches: true },
      },
    },
    take: 10,
  });
  console.log('\n--- Non-MATCHED articles with unvalidated matches ---');
  console.log('Count:', otherWithUnvalidated.length);
  if (otherWithUnvalidated.length > 0) {
    otherWithUnvalidated.forEach((a) => {
      console.log(`  - ID: ${a.id}, Status: ${a.status}, Matches: ${a._count.marketMatches}, Title: ${a.title.substring(0, 50)}`);
    });
  }

  // Check matches that have isValidated=false but their article is not MATCHED
  const orphanedMatches = await prisma.newsMarketMatch.findMany({
    where: {
      isValidated: false,
      newsArticle: {
        status: { not: NewsStatus.MATCHED },
      },
    },
    include: {
      newsArticle: {
        select: { id: true, status: true, title: true },
      },
    },
    take: 10,
  });
  console.log('\n--- Unvalidated matches with non-MATCHED articles ---');
  console.log('Count:', orphanedMatches.length);
  if (orphanedMatches.length > 0) {
    orphanedMatches.forEach((m) => {
      console.log(`  - Match ID: ${m.id}, Article Status: ${m.newsArticle.status}, Title: ${m.newsArticle.title.substring(0, 50)}`);
    });
  }

  // Check contracts - are there active contracts?
  const activeContracts = await prisma.contract.count({
    where: { isActive: true },
  });
  console.log('\n--- Active Contracts ---');
  console.log('Count:', activeContracts);

  // Check if matches have markets with contracts
  const matchesWithoutContracts = await prisma.newsMarketMatch.count({
    where: {
      isValidated: false,
      market: {
        contracts: {
          none: { isActive: true },
        },
      },
    },
  });
  console.log('\n--- Unvalidated matches where market has no active contracts ---');
  console.log('Count:', matchesWithoutContracts);

  await prisma.$disconnect();
}

main().catch(console.error);
