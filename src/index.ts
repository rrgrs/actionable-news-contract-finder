import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { ConfigLoader } from './config/ConfigLoader';
import { NewsServiceRegistry } from './services/news/NewsServiceRegistry';
import { BettingPlatformRegistry } from './services/betting/BettingPlatformRegistry';
import { LLMProviderRegistry } from './services/llm/LLMProviderRegistry';
import { EmbeddingService } from './services/embedding/EmbeddingService';
import { NewsServiceRunner } from './runners/NewsServiceRunner';
import { PlatformSyncRunner } from './runners/PlatformSyncRunner';
import { EmbeddingWorker } from './workers/EmbeddingWorker';
import { MatchingWorker } from './workers/MatchingWorker';
import { ValidationWorker } from './workers/ValidationWorker';

dotenv.config();

async function main() {
  console.log('Starting Actionable News Contract Finder...\n');

  try {
    // Load configuration from environment
    console.log('Loading configuration from environment...');
    const config = ConfigLoader.loadConfig();

    console.log('\nConfigured services:');
    console.log(`  News Services: ${config.newsServices.map((s) => s.name).join(', ')}`);
    console.log(`  Betting Platforms: ${config.bettingPlatforms.map((p) => p.name).join(', ')}`);
    console.log(`  LLM Providers: ${config.llmProviders.map((p) => p.name).join(', ')}`);
    console.log('');

    // Validate configuration early
    console.log('Validating service configurations...\n');
    await ConfigLoader.validateConfiguration(config);

    // Load and register all services
    console.log('Loading and initializing services...\n');
    const { newsServices, bettingPlatforms, llmProviders } =
      await ConfigLoader.loadAndRegisterServices(
        config,
        NewsServiceRegistry,
        BettingPlatformRegistry,
        LLMProviderRegistry,
      );

    // Initialize database and embedding service
    const prisma = new PrismaClient();
    await prisma.$connect();
    console.log('Database connected');

    const embeddingService = new EmbeddingService(config.embedding);

    // Create runners for each news service
    const newsRunners = newsServices.map(
      (service) =>
        new NewsServiceRunner({
          name: `NewsRunner:${service.name}`,
          service,
          prisma,
          minDelayMs: 1000,
          maxDelayMs: 60000,
        }),
    );

    // Create runners for each betting platform
    const platformRunners = bettingPlatforms.map(
      (platform) =>
        new PlatformSyncRunner({
          name: `PlatformRunner:${platform.name}`,
          platform,
          prisma,
          embeddingService,
          embeddingBatchSize: config.embedding.batchSize || 100,
          minDelayMs: 5000,
          maxDelayMs: 300000,
        }),
    );

    // Create workers for the processing pipeline
    const embeddingWorker = new EmbeddingWorker({
      name: 'EmbeddingWorker',
      prisma,
      embeddingService,
      batchSize: 10,
      idleDelayMs: 1000,
    });

    const matchingWorker = new MatchingWorker({
      name: 'MatchingWorker',
      prisma,
      topN: config.matching.topN,
      minSimilarity: config.matching.minSimilarity,
      batchSize: 5,
      idleDelayMs: 1000,
    });

    const validationWorker = new ValidationWorker({
      name: 'ValidationWorker',
      prisma,
      llmProvider: llmProviders[0],
      minConfidence: config.validation.minConfidenceScore,
      alertConfig: config.alerts,
      batchSize: 3,
      idleDelayMs: 2000,
    });

    // Start all runners and workers
    console.log('\nStarting news runners...');
    for (const runner of newsRunners) {
      await runner.start();
    }

    console.log('Starting platform runners...');
    for (const runner of platformRunners) {
      await runner.start();
    }

    console.log('Starting workers...');
    await embeddingWorker.start();
    await matchingWorker.start();
    await validationWorker.start();

    console.log('\nAll services started successfully');
    console.log(`  News Runners: ${newsRunners.length}`);
    console.log(`  Platform Runners: ${platformRunners.length}`);
    console.log(`  Workers: 3 (Embedding, Matching, Validation)`);

    console.log('\nConfiguration:');
    console.log(`  Min Confidence Score: ${config.validation.minConfidenceScore}`);
    console.log(`  Top Matching Markets: ${config.matching.topN}`);
    if (config.matching.minSimilarity) {
      console.log(`  Min Similarity: ${config.matching.minSimilarity}`);
    }
    console.log(`  Embedding Model: ${config.embedding.model || 'text-embedding-004'}`);
    console.log(`  Dry Run Mode: ${config.validation.dryRun ? 'ENABLED' : 'DISABLED'}`);
    console.log(`  Place Bets: ${config.validation.placeBets ? 'ENABLED' : 'DISABLED'}`);

    console.log('\nAlert Configuration:');
    console.log(`  Alert Type: ${config.alerts.type.toUpperCase()}`);
    if (config.alerts.type !== 'none') {
      console.log(`  Min Confidence Threshold: ${config.alerts.minConfidenceThreshold || 0.7}`);
      console.log(`  Cooldown Period: ${config.alerts.cooldownMinutes || 30} minutes`);
      if (config.alerts.type === 'email' || config.alerts.type === 'both') {
        console.log(
          `  Email Recipients: ${config.alerts.emailConfig?.to?.join(', ') || 'Not configured'}`,
        );
      }
    }
    console.log('');

    // Handle graceful shutdown
    const shutdown = async () => {
      console.log('\nReceived shutdown signal, stopping gracefully...');

      // Stop workers first
      await validationWorker.stop();
      await matchingWorker.stop();
      await embeddingWorker.stop();

      // Stop platform runners
      for (const runner of platformRunners) {
        await runner.stop();
      }

      // Stop news runners
      for (const runner of newsRunners) {
        await runner.stop();
      }

      // Cleanup registries
      await NewsServiceRegistry.destroyAllServices();
      await BettingPlatformRegistry.destroyAllPlatforms();
      await LLMProviderRegistry.destroyAllProviders();

      // Disconnect database
      await prisma.$disconnect();

      console.log('Goodbye!\n');
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    console.log('Application is running. Press Ctrl+C to stop.\n');
  } catch (error) {
    console.error('\nFailed to start application:', error);

    if (error instanceof Error && error.message.includes('validation failed')) {
      console.error(
        '\nPlease check your .env configuration and ensure all specified services exist.',
      );
      console.error('   Services should be comma-separated in the environment variables:');
      console.error('   - NEWS_SERVICES=mock-news,newsapi');
      console.error('   - BETTING_PLATFORMS=mock-betting,kalshi');
      console.error('   - LLM_PROVIDERS=mock-llm,openai');
    }

    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
