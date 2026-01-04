/**
 * Debug script to compare news from APIs vs what's in the database
 */
import prisma from '../src/lib/prisma';

// Import news service plugins
import { RSSAggregatorServicePlugin } from '../src/services/news/plugins/RSSAggregatorService';
import { RedditNewsServicePlugin } from '../src/services/news/plugins/RedditNewsService';
import { GDELTNewsServicePlugin } from '../src/services/news/plugins/GDELTNewsService';
import { FinnhubNewsServicePlugin } from '../src/services/news/plugins/FinnhubNewsService';

async function main() {
  console.log('=== News Source Debug ===\n');
  console.log(`Current time: ${new Date().toISOString()}\n`);

  // Get processed news IDs from DB
  const processedNews = await prisma.processedNews.findMany({
    select: { newsId: true, processedAt: true },
    orderBy: { processedAt: 'desc' },
  });
  const processedIds = new Set(processedNews.map((n) => n.newsId));

  console.log(`Database stats:`);
  console.log(`  Total processed: ${processedNews.length}`);
  console.log(`  Newest: ${processedNews[0]?.processedAt?.toISOString() || 'N/A'}`);
  console.log(`  Oldest: ${processedNews[processedNews.length - 1]?.processedAt?.toISOString() || 'N/A'}`);
  console.log('');

  // Test each news service
  const services = [
    { name: 'rss-aggregator', plugin: RSSAggregatorServicePlugin },
    { name: 'reddit-news', plugin: RedditNewsServicePlugin },
    { name: 'gdelt-news', plugin: GDELTNewsServicePlugin },
    { name: 'finnhub-news', plugin: FinnhubNewsServicePlugin },
  ];

  for (const { name, plugin } of services) {
    console.log(`\n--- ${name} ---`);
    try {
      const service = plugin.create({ name, customConfig: {} });
      await service.initialize({ name, customConfig: {} });

      const news = await service.fetchLatestNews();
      const newItems = news.filter((item) => !processedIds.has(item.id));
      const existingItems = news.filter((item) => processedIds.has(item.id));

      console.log(`  Fetched: ${news.length} items`);
      console.log(`  New (not in DB): ${newItems.length}`);
      console.log(`  Already processed: ${existingItems.length}`);

      if (newItems.length > 0) {
        console.log(`  Sample new IDs:`);
        newItems.slice(0, 3).forEach((item) => {
          console.log(`    - ${item.id}: ${item.title.substring(0, 60)}...`);
        });
      }

      if (news.length > 0) {
        // Check ID patterns
        const idPrefixes = new Map<string, number>();
        news.forEach((item) => {
          const prefix = item.id.split('_')[0] || item.id.substring(0, 10);
          idPrefixes.set(prefix, (idPrefixes.get(prefix) || 0) + 1);
        });
        console.log(`  ID prefixes: ${Array.from(idPrefixes.entries()).map(([k, v]) => `${k}(${v})`).join(', ')}`);

        // Check publication dates
        const now = Date.now();
        const ages = news.map((item) => (now - item.publishedAt.getTime()) / 1000 / 60); // minutes
        console.log(`  Age range: ${Math.min(...ages).toFixed(0)} - ${Math.max(...ages).toFixed(0)} minutes old`);
      }

      await service.destroy();
    } catch (error) {
      console.log(`  ERROR: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Check for ID collision patterns
  console.log('\n\n--- ID Analysis ---');
  const idsByPrefix = new Map<string, number>();
  processedNews.forEach((n) => {
    const prefix = n.newsId.split('_')[0] || n.newsId.substring(0, 10);
    idsByPrefix.set(prefix, (idsByPrefix.get(prefix) || 0) + 1);
  });
  console.log('Processed news by ID prefix:');
  Array.from(idsByPrefix.entries())
    .sort((a, b) => b[1] - a[1])
    .forEach(([prefix, count]) => {
      console.log(`  ${prefix}: ${count}`);
    });

  await prisma.$disconnect();
}

main().catch(console.error);
