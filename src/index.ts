import dotenv from 'dotenv';
import { ConfigLoader } from './config/ConfigLoader';
import { NewsServiceRegistry } from './services/news/NewsServiceRegistry';
import { BettingPlatformRegistry } from './services/betting/BettingPlatformRegistry';
import { LLMProviderRegistry } from './services/llm/LLMProviderRegistry';
import { OrchestratorService } from './services/orchestrator/OrchestratorService';
import { OrchestratorServiceV2 } from './services/orchestrator/OrchestratorServiceV2';

dotenv.config();

async function main() {
  console.log('🚀 Starting Actionable News Contract Finder...\n');

  try {
    // Load configuration from environment
    console.log('📋 Loading configuration from environment...');
    const config = ConfigLoader.loadConfig();

    console.log('\nConfigured services:');
    console.log(`  📰 News Services: ${config.newsServices.map((s) => s.name).join(', ')}`);
    console.log(`  🎲 Betting Platforms: ${config.bettingPlatforms.map((p) => p.name).join(', ')}`);
    console.log(`  🤖 LLM Providers: ${config.llmProviders.map((p) => p.name).join(', ')}`);
    console.log('');

    // Validate configuration early
    console.log('🔍 Validating service configurations...\n');
    await ConfigLoader.validateConfiguration(config);

    // Load and register all services
    console.log('📦 Loading and initializing services...\n');
    const { newsServices, bettingPlatforms, llmProviders } =
      await ConfigLoader.loadAndRegisterServices(
        config,
        NewsServiceRegistry,
        BettingPlatformRegistry,
        LLMProviderRegistry,
      );

    // Create orchestrator with all services
    let orchestrator: OrchestratorService | OrchestratorServiceV2;

    if (config.useV2Orchestrator) {
      // Check if embedding API key is available
      if (!config.embedding.apiKey) {
        console.warn('\n⚠️  Warning: V2 orchestrator requires an embedding API key.');
        console.warn('   Set GEMINI_API_KEY or EMBEDDING_API_KEY in your .env file.');
        console.warn('   Falling back to legacy orchestrator (search-based).\n');

        orchestrator = new OrchestratorService(
          config.orchestrator,
          newsServices,
          bettingPlatforms,
          llmProviders,
          config.alerts,
        );
      } else {
        // Use V2 orchestrator with embedding-based matching
        orchestrator = new OrchestratorServiceV2(
          {
            ...config.orchestrator,
            marketSyncIntervalMs: config.betSync.syncIntervalMs,
            embeddingBatchSize: config.betSync.embeddingBatchSize,
            topMatchingMarkets: config.betMatching.topN,
            minSimilarityScore: config.betMatching.minSimilarity,
          },
          newsServices,
          bettingPlatforms,
          llmProviders,
          config.embedding,
          config.alerts,
        );
      }
    } else {
      // Use legacy orchestrator (search-based)
      orchestrator = new OrchestratorService(
        config.orchestrator,
        newsServices,
        bettingPlatforms,
        llmProviders,
        config.alerts,
      );
    }

    console.log('\n✅ All services initialized successfully');
    console.log('\n📊 Orchestrator Configuration:');
    console.log(
      `  - Architecture: ${orchestrator instanceof OrchestratorServiceV2 ? 'V2 (Embedding-based)' : 'Legacy (Search-based)'}`,
    );
    console.log(`  - Poll Interval: ${config.orchestrator.pollIntervalMs}ms`);
    console.log(`  - Min Relevance Score: ${config.orchestrator.minRelevanceScore}`);
    console.log(`  - Min Confidence Score: ${config.orchestrator.minConfidenceScore}`);
    console.log(`  - Max Positions Per Contract: ${config.orchestrator.maxPositionsPerContract}`);
    console.log(`  - Dry Run Mode: ${config.orchestrator.dryRun ? 'ENABLED' : 'DISABLED'}`);
    console.log(`  - Place Bets: ${config.orchestrator.placeBets ? 'ENABLED' : 'DISABLED'}`);

    if (orchestrator instanceof OrchestratorServiceV2) {
      console.log('\n📊 Market Sync Configuration (V2):');
      console.log(`  - Sync Interval: ${config.betSync.syncIntervalMs / 60000} minutes`);
      console.log(`  - Top Matching Markets: ${config.betMatching.topN}`);
      console.log(`  - Embedding Model: ${config.embedding.model || 'text-embedding-004'}`);
      if (config.betMatching.minSimilarity) {
        console.log(`  - Min Similarity: ${config.betMatching.minSimilarity}`);
      }
    }
    console.log('');

    console.log('\n📢 Alert Configuration:');
    console.log(`  - Alert Type: ${config.alerts.type.toUpperCase()}`);
    if (config.alerts.type !== 'none') {
      console.log(`  - Min Confidence Threshold: ${config.alerts.minConfidenceThreshold || 0.7}`);
      console.log(`  - Cooldown Period: ${config.alerts.cooldownMinutes || 30} minutes`);
      if (config.alerts.type === 'email' || config.alerts.type === 'both') {
        console.log(
          `  - Email Recipients: ${config.alerts.emailConfig?.to?.join(', ') || 'Not configured'}`,
        );
      }
    }
    console.log('');

    // Start the orchestrator
    await orchestrator.start();

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\n\n🛑 Received SIGINT, shutting down gracefully...');

      await orchestrator.stop();
      await NewsServiceRegistry.destroyAllServices();
      await BettingPlatformRegistry.destroyAllPlatforms();
      await LLMProviderRegistry.destroyAllProviders();

      console.log('👋 Goodbye!\n');
      process.exit(0);
    });

    console.log('Application is running. Press Ctrl+C to stop.\n');
  } catch (error) {
    console.error('\n❌ Failed to start application:', error);

    if (error instanceof Error && error.message.includes('validation failed')) {
      console.error(
        '\n💡 Please check your .env configuration and ensure all specified services exist.',
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
  console.error('💥 Unhandled error:', error);
  process.exit(1);
});
