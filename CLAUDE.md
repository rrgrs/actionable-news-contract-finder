# Actionable News Contract Finder - Project Documentation

## Project Overview

The Actionable News Contract Finder is an automated system that monitors news feeds, uses AI to analyze news for market-moving events, searches betting/prediction markets for relevant contracts, and can optionally place trades based on the analysis. The system is built with a plugin-based architecture allowing easy integration of multiple news sources, betting platforms, and LLM providers.

## Core Architecture

### Main Components

1. **News Services** - Fetch and aggregate news from multiple sources
2. **LLM Providers** - Analyze news content for market implications
3. **Betting Platforms** - Search and trade on prediction markets
4. **Orchestrator** - Coordinates all services and manages the main workflow
5. **Alert System** - Notifies users of trading opportunities

### Key Design Patterns

- **Plugin Architecture**: All services (news, LLM, betting) are loaded as plugins from their respective `/plugins` directories
- **Registry Pattern**: Each service type has a registry that manages plugin registration and service lifecycle
- **Dependency Injection**: Services are injected into the orchestrator at runtime based on configuration
- **Mock Services**: Every service type has a mock implementation for testing and development

## Directory Structure

```
src/
├── index.ts                    # Main entry point, initializes and starts orchestrator
├── config/
│   ├── ConfigLoader.ts        # Loads config from environment, discovers and validates plugins
│   └── types.ts               # Configuration type definitions
├── types/
│   ├── news.types.ts          # News service interfaces
│   ├── betting.types.ts       # Betting platform interfaces
│   ├── analysis.types.ts      # LLM and analysis interfaces
│   └── index.ts               # Type exports
├── services/
│   ├── orchestrator/
│   │   └── OrchestratorServiceV2.ts  # Main workflow coordinator
│   ├── news/
│   │   ├── NewsServiceRegistry.ts    # Manages news service plugins
│   │   └── plugins/                  # News service implementations
│   │       └── MockNewsService.ts    # Mock news for testing
│   ├── betting/
│   │   ├── BettingPlatformRegistry.ts # Manages betting platform plugins
│   │   └── plugins/                   # Betting platform implementations
│   │       └── MockBettingPlatform.ts # Mock betting for testing
│   ├── llm/
│   │   ├── LLMProviderRegistry.ts    # Manages LLM provider plugins
│   │   └── plugins/                  # LLM provider implementations
│   │       └── MockLLMProvider.ts    # Mock LLM for testing
│   ├── analysis/
│   │   ├── NewsParserService.ts      # Parses news using LLMs
│   │   └── ContractValidatorService.ts # Validates betting contracts against news
│   └── alerts/
│       └── AlertService.ts           # Handles email/system alerts
```

## Main Workflow

The orchestrator runs a continuous polling cycle:

1. **Fetch News** (`fetchAllNews`)
   - Polls all configured news services
   - Filters out already-processed news items
   - Returns sorted by publication date

2. **Parse News** (`parseNews`)
   - Uses LLM to analyze each news item
   - Extracts: entities, events, predictions, sentiment
   - Calculates relevance score
   - Generates suggested betting actions

3. **Find Markets** (for each high-relevance insight)
   - Searches betting platforms for relevant markets
   - Uses suggested market queries from news analysis

4. **Validate Contracts** (`batchValidateContracts`)
   - For each market, gets available contracts
   - Uses LLM to validate contract relevance to news
   - Scores confidence and suggests position (buy/sell/hold)

5. **Execute Trades** (if configured)
   - Sends alerts for high-confidence opportunities
   - Places orders if PLACE_BETS=true and not in dry run
   - Tracks active positions

## Configuration

### Environment Variables

The system is configured entirely through environment variables. See `.env.example` for full documentation.

#### Service Selection
```bash
NEWS_SERVICES=mock-news,newsapi           # Comma-separated list
BETTING_PLATFORMS=mock-betting,kalshi     # Comma-separated list
LLM_PROVIDERS=mock-llm,openai            # Comma-separated list
```

#### Service-Specific Config
Format: `<SERVICE_TYPE>_<SERVICE_NAME>_<CONFIG_KEY>=value`
```bash
NEWS_NEWSAPI_APIKEY=your_key_here
BETTING_KALSHI_APIKEY=your_key_here
LLM_OPENAI_APIKEY=your_key_here
```

#### Orchestrator Settings
```bash
POLL_INTERVAL_MS=60000          # How often to check for news
MIN_RELEVANCE_SCORE=0.5         # Min score to consider news
MIN_CONFIDENCE_SCORE=0.6        # Min confidence to place bet
PLACE_BETS=false               # Enable actual bet placement
DRY_RUN=true                   # Simulate bets only
```

#### Alert Configuration
```bash
ALERT_TYPE=email               # none, email, system, both
ALERT_MIN_CONFIDENCE=0.7       # Min confidence for alerts
ALERT_EMAIL_TO=user@example.com
ALERT_SMTP_HOST=smtp.gmail.com
```

## Adding New Services

### 1. Create a News Service Plugin

```typescript
// src/services/news/plugins/YourNewsService.ts
import { NewsService, NewsServiceConfig, NewsItem } from '../../../types';

class YourNewsService implements NewsService {
  name = 'your-news';

  async initialize(config: NewsServiceConfig): Promise<void> {
    // Setup API client
  }

  async fetchLatestNews(): Promise<NewsItem[]> {
    // Fetch and transform news
  }

  async searchNews(query: string): Promise<NewsItem[]> {
    // Search implementation
  }

  async isHealthy(): Promise<boolean> {
    // Health check
  }

  async destroy(): Promise<void> {
    // Cleanup
  }
}

export const YourNewsServicePlugin = {
  create: (config: NewsServiceConfig) => new YourNewsService()
};
```

### 2. Create a Betting Platform Plugin

```typescript
// src/services/betting/plugins/YourPlatform.ts
import { BettingPlatform, Market, Contract, Position } from '../../../types';

class YourPlatform implements BettingPlatform {
  name = 'your-platform';

  async searchMarkets(query: string): Promise<Market[]> {
    // Search markets matching query
  }

  async getContracts(marketId: string): Promise<Contract[]> {
    // Get tradeable contracts for market
  }

  async placeOrder(contractId: string, side: 'buy'|'sell', quantity: number): Promise<Position> {
    // Execute trade
  }

  // ... other required methods
}

export const YourPlatformPlugin = {
  create: (config) => new YourPlatform()
};
```

### 3. Create an LLM Provider Plugin

```typescript
// src/services/llm/plugins/YourLLM.ts
import { LLMProvider, LLMProviderConfig } from '../../../types';

class YourLLM implements LLMProvider {
  name = 'your-llm';

  async generateCompletion(prompt: string, systemPrompt?: string): Promise<string> {
    // Call LLM API
  }

  async generateStructuredOutput<T>(prompt: string, schema: any): Promise<T> {
    // Generate JSON matching schema
  }

  // ... other required methods
}

export const YourLLMPlugin = {
  create: (config) => new YourLLM()
};
```

## Key Data Types

### NewsItem
```typescript
{
  id: string;
  source: string;
  title: string;
  content: string;
  url: string;
  publishedAt: Date;
  tags?: string[];
}
```

### ParsedNewsInsight
```typescript
{
  originalNewsId: string;
  summary: string;
  entities: Entity[];        // People, orgs, locations
  events: Event[];           // What happened or will happen
  predictions: Prediction[]; // Market predictions
  sentiment: Sentiment;      // Positive/negative/neutral scores
  relevanceScore: number;    // 0-1 importance score
  suggestedActions: SuggestedAction[]; // Betting opportunities
}
```

### Contract
```typescript
{
  id: string;
  marketId: string;
  platform: string;
  title: string;
  outcome: string;
  currentPrice: number;
  expiresAt?: Date;
}
```

### ContractValidation
```typescript
{
  contractId: string;
  isRelevant: boolean;
  relevanceScore: number;
  suggestedPosition?: 'buy' | 'sell' | 'hold';
  suggestedConfidence: number;
  reasoning: string;
}
```

## Testing

The project includes comprehensive test coverage:

```bash
npm test                # Run all tests
npm run test:watch      # Watch mode
npm run test:coverage   # Coverage report
```

Each service has both unit tests and integration tests with mock implementations.

## Development Workflow

1. **Start with mocks**: Use mock services to develop without API keys
2. **Add real services**: Create plugins for actual APIs
3. **Test thoroughly**: Each plugin should have comprehensive tests
4. **Configure via .env**: All configuration through environment variables
5. **Monitor logs**: The orchestrator provides detailed logging of each cycle

## Important Files for Development

- `src/index.ts` - Main entry point, understand startup flow
- `src/services/orchestrator/OrchestratorServiceV2.ts` - Core business logic
- `src/config/ConfigLoader.ts` - Plugin discovery and loading
- `src/types/*.types.ts` - All interfaces and contracts
- `.env.example` - Configuration documentation

## Common Commands

```bash
npm run dev        # Start in development mode with hot reload
npm run build      # Compile TypeScript
npm start          # Run compiled JavaScript
npm run lint       # Check code style
npm run typecheck  # Check TypeScript types
npm run check      # Run both lint and typecheck
```

## Safety Features

1. **Dry Run Mode**: Test strategies without real money
2. **PLACE_BETS Flag**: Explicit opt-in for real trading
3. **Confidence Thresholds**: Only trade high-confidence opportunities
4. **Position Limits**: MAX_POSITIONS_PER_CONTRACT prevents overexposure
5. **Alert System**: Get notified before automated trades
6. **Health Checks**: All services implement health monitoring

## Extending the System

The plugin architecture makes it easy to add:

- **More news sources**: RSS feeds, Twitter, Reddit, financial APIs
- **More betting platforms**: Polymarket, Manifold, sports betting
- **More LLM providers**: Anthropic, Cohere, local models
- **Custom analysis**: Sentiment analysis, technical indicators
- **Risk management**: Position sizing, portfolio limits
- **Backtesting**: Historical data analysis

## Performance Considerations

- News IDs are tracked to avoid reprocessing (max 1000 cached)
- Batch processing for contracts validation
- Configurable poll intervals to balance freshness vs API limits
- Parallel service initialization at startup
- Graceful shutdown handling

## Error Handling

- Each service call is wrapped in try-catch
- Failures in one service don't stop the orchestrator
- Detailed error logging with context
- Health checks for service monitoring
- Automatic retry logic can be added to plugins