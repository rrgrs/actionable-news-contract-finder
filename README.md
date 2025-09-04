# Actionable News Contract Finder

An extensible TypeScript application that monitors news sources, analyzes them using LLMs, and identifies relevant betting opportunities on prediction markets.

## Features

- ✅ **Pluggable Architecture**: Extensible plugins for news sources, LLM providers, and betting platforms
- ✅ **Real-Time News Monitoring**: Continuously polls configured news sources for updates
- ✅ **LLM-Powered Analysis**: Extract insights, entities, events, and predictions from news
- ✅ **Smart Contract Discovery**: Automatically finds relevant prediction market contracts
- ✅ **Contract Validation**: LLM validates that contracts match news events before betting
- ✅ **Automated Trading**: Place orders automatically based on confidence thresholds
- ✅ **Alert System**: Email and system notifications for high-confidence opportunities
- ✅ **Dry Run Mode**: Test strategies without placing real orders
- ✅ **Comprehensive Logging**: Track all activities and decisions

## Architecture

The system uses a fully modular plugin-based architecture:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   News Sources  │────▶│  LLM Analysis   │────▶│ Betting Markets │
├─────────────────┤     ├─────────────────┤     ├─────────────────┤
│ - RSS Feeds     │     │ - OpenAI        │     │ - Kalshi        │
│ - News APIs     │     │ - Anthropic     │     │ - Polymarket    │
│ - Custom Sources│     │ - Local Models  │     │ - Custom Markets│
└─────────────────┘     └─────────────────┘     └─────────────────┘
         │                       │                        │
         └───────────────────────┴────────────────────────┘
                                │
                    ┌───────────▼───────────┐
                    │    Orchestrator       │
                    ├───────────────────────┤
                    │ - News Processing     │
                    │ - Contract Validation │
                    │ - Position Management │
                    │ - Alert Dispatching   │
                    └───────────────────────┘
```

## Project Structure

```
src/
├── types/                  # TypeScript interfaces
│   ├── news.types.ts      # News service interfaces
│   ├── betting.types.ts   # Betting platform interfaces
│   └── analysis.types.ts  # LLM and analysis interfaces
├── services/
│   ├── news/              # News service plugins
│   │   └── plugins/       # News source implementations
│   ├── betting/           # Betting platform plugins
│   │   └── plugins/       # Platform implementations
│   ├── llm/               # LLM provider plugins
│   │   └── plugins/       # Provider implementations
│   ├── analysis/          # Core analysis services
│   │   ├── NewsParserService.ts      # Parse news with LLMs
│   │   └── ContractValidatorService.ts # Validate contracts
│   ├── alerts/            # Alert system
│   │   └── AlertService.ts # Email & system notifications
│   └── orchestrator/      # Main orchestration logic
│       ├── OrchestratorService.ts    # V1 orchestrator
│       └── OrchestratorServiceV2.ts  # V2 with alerts
├── config/
│   ├── ConfigLoader.ts   # Dynamic configuration loader
│   └── types.ts          # Configuration interfaces
└── index.ts              # Application entry point
```

## Installation

1. **Clone the repository:**
```bash
git clone <repository-url>
cd actionable-news-contract-finder
```

2. **Install dependencies:**
```bash
npm install
```

3. **Set up configuration:**
```bash
cp .env.example .env
# Edit .env with your configuration
```

## Configuration

### Environment Variables

The application is configured entirely through environment variables. Here's a complete guide:

#### Core Settings
```bash
# Orchestrator Configuration
POLL_INTERVAL_MS=60000              # How often to check for news (ms)
MIN_RELEVANCE_SCORE=0.7             # Min relevance score (0-1) to process news
MIN_CONFIDENCE_SCORE=0.6            # Min confidence (0-1) to place orders
MAX_POSITIONS_PER_CONTRACT=3        # Max positions per betting contract
DRY_RUN=false                       # Test mode (no real orders)
PLACE_BETS=true                     # Enable/disable actual bet placement

# Logging
LOG_LEVEL=info                      # Log level: debug, info, warn, error
```

#### Service Configuration
```bash
# News Services (comma-separated list of plugin names)
NEWS_SERVICES=MockNewsService
# Each news service can have its own config:
NEWS_<SERVICE_NAME>_API_KEY=your-api-key
NEWS_<SERVICE_NAME>_BASE_URL=https://api.example.com

# Betting Platforms (comma-separated list of plugin names)
BETTING_PLATFORMS=MockBettingPlatform
# Each platform can have its own config:
BETTING_<PLATFORM_NAME>_API_KEY=your-api-key
BETTING_<PLATFORM_NAME>_API_SECRET=your-secret
BETTING_<PLATFORM_NAME>_TEST_MODE=true

# LLM Providers (comma-separated list of plugin names)
LLM_PROVIDERS=MockLLMProvider
# Each provider can have its own config:
LLM_<PROVIDER_NAME>_API_KEY=your-api-key
LLM_<PROVIDER_NAME>_MODEL=gpt-4
LLM_<PROVIDER_NAME>_TEMPERATURE=0.7
LLM_<PROVIDER_NAME>_MAX_TOKENS=2000
```

#### Alert Configuration
```bash
# Alert System
ALERT_TYPE=both                     # none, email, system, or both
ALERT_MIN_CONFIDENCE=0.7            # Min confidence to trigger alerts
ALERT_COOLDOWN_MINUTES=30           # Cooldown between alerts for same market

# Email Configuration (required if ALERT_TYPE includes email)
ALERT_EMAIL_TO=user@example.com,team@example.com  # Comma-separated recipients
ALERT_EMAIL_FROM=alerts@yourapp.com               # Sender email
ALERT_SMTP_HOST=smtp.gmail.com                    # SMTP server
ALERT_SMTP_PORT=587                               # SMTP port
ALERT_SMTP_USER=your-email@gmail.com              # SMTP username
ALERT_SMTP_PASS=your-app-password                 # SMTP password
```

### Example .env File

```bash
# Core Configuration
POLL_INTERVAL_MS=60000
MIN_RELEVANCE_SCORE=0.7
MIN_CONFIDENCE_SCORE=0.6
MAX_POSITIONS_PER_CONTRACT=3
DRY_RUN=true
PLACE_BETS=false
LOG_LEVEL=info

# Services (using mock providers for testing)
NEWS_SERVICES=MockNewsService
BETTING_PLATFORMS=MockBettingPlatform
LLM_PROVIDERS=MockLLMProvider

# Alerts
ALERT_TYPE=system
ALERT_MIN_CONFIDENCE=0.8
ALERT_COOLDOWN_MINUTES=30

# Production Example (commented out)
# NEWS_SERVICES=RSSFeedService,NewsAPIService
# NEWS_NEWSAPISERVICE_API_KEY=your-newsapi-key
# BETTING_PLATFORMS=KalshiPlatform,PolymarketPlatform
# BETTING_KALSHIPLATFORM_API_KEY=your-kalshi-key
# LLM_PROVIDERS=OpenAIProvider
# LLM_OPENAIPROVIDER_API_KEY=your-openai-key
# LLM_OPENAIPROVIDER_MODEL=gpt-4-turbo-preview
```

## Running the Application

### Development Mode
```bash
npm run dev
```

### Production Mode
```bash
npm run build
npm start
```

### Testing
```bash
# Run all tests
npm test

# Run tests with coverage
npm run test:coverage

# Run linter
npm run lint

# Run type checker
npm run typecheck
```

## Creating Custom Plugins

### News Service Plugin

Create a new file in `src/services/news/plugins/`:

```typescript
import { 
  NewsService, 
  NewsServicePlugin, 
  NewsServiceConfig, 
  NewsItem 
} from '../../../types';

export class MyNewsService implements NewsService {
  name = 'MyNewsService';
  private config: NewsServiceConfig;

  async initialize(config: NewsServiceConfig): Promise<void> {
    this.config = config;
    // Initialize your news source connection
  }

  async fetchLatestNews(): Promise<NewsItem[]> {
    // Fetch and return news items
    return [];
  }

  async searchNews(query: string, from?: Date, to?: Date): Promise<NewsItem[]> {
    // Search for specific news
    return [];
  }

  async isHealthy(): Promise<boolean> {
    // Check if service is working
    return true;
  }

  async destroy(): Promise<void> {
    // Cleanup resources
  }
}

export const MyNewsServicePlugin: NewsServicePlugin = {
  create: (config) => new MyNewsService(),
};
```

### LLM Provider Plugin

Create a new file in `src/services/llm/plugins/`:

```typescript
import { 
  LLMProvider, 
  LLMProviderPlugin, 
  LLMProviderConfig 
} from '../../../types';

export class MyLLMProvider implements LLMProvider {
  name = 'MyLLMProvider';
  private config: LLMProviderConfig;

  async initialize(config: LLMProviderConfig): Promise<void> {
    this.config = config;
    // Initialize LLM connection
  }

  async generateCompletion(
    prompt: string, 
    systemPrompt?: string
  ): Promise<string> {
    // Generate text completion
    return 'response';
  }

  async generateStructuredOutput<T>(
    prompt: string, 
    schema: any, 
    systemPrompt?: string
  ): Promise<T> {
    // Generate structured JSON output
    return {} as T;
  }

  async isHealthy(): Promise<boolean> {
    return true;
  }

  async destroy(): Promise<void> {
    // Cleanup
  }
}

export const MyLLMProviderPlugin: LLMProviderPlugin = {
  create: (config) => new MyLLMProvider(),
};
```

### Betting Platform Plugin

Create a new file in `src/services/betting/plugins/`:

```typescript
import { 
  BettingPlatform, 
  BettingPlatformPlugin,
  BettingPlatformConfig,
  Market,
  Contract,
  Position 
} from '../../../types';

export class MyBettingPlatform implements BettingPlatform {
  name = 'MyBettingPlatform';
  private config: BettingPlatformConfig;

  async initialize(config: BettingPlatformConfig): Promise<void> {
    this.config = config;
    // Initialize platform connection
  }

  async searchMarkets(query: string): Promise<Market[]> {
    // Search for relevant markets
    return [];
  }

  async getContracts(marketId: string): Promise<Contract[]> {
    // Get contracts for a market
    return [];
  }

  async placeOrder(
    contractId: string,
    side: 'buy' | 'sell',
    quantity: number,
    price?: number
  ): Promise<Position> {
    // Place an order
    throw new Error('Not implemented');
  }

  // Implement other required methods...

  async isHealthy(): Promise<boolean> {
    return true;
  }

  async destroy(): Promise<void> {
    // Cleanup
  }
}

export const MyBettingPlatformPlugin: BettingPlatformPlugin = {
  create: (config) => new MyBettingPlatform(),
};
```

## Alert System

The application includes a comprehensive alert system that can notify you of high-confidence betting opportunities:

### Alert Types

- **System Notifications**: Native desktop notifications (macOS, Windows, Linux)
- **Email Alerts**: SMTP-based email notifications with detailed opportunity information
- **Both**: Send both system and email notifications
- **None**: Disable all alerts

### Alert Content

Alerts include:
- News event that triggered the opportunity
- Market and contract details
- Suggested position (buy/sell)
- Confidence score
- Current price
- Analysis reasoning
- Direct links to news and market

### Alert Filtering

- **Confidence Threshold**: Only alert for opportunities above specified confidence
- **Cooldown Period**: Prevent spam by limiting alerts per market
- **Smart Deduplication**: Won't alert twice for the same news event

## Monitoring & Debugging

### Logs

The application provides detailed logging at multiple levels:
- `debug`: Verbose debugging information
- `info`: General operational information
- `warn`: Warning messages
- `error`: Error messages only

### Status Endpoint

When running, the orchestrator provides status information including:
- Running state
- Active services count
- Processed news count
- Active positions
- Configuration details

### Dry Run Mode

Test your configuration without risking real money:
- Set `DRY_RUN=true` to simulate all operations
- Orders are logged but not placed
- Perfect for testing strategies

## Best Practices

1. **Start with Dry Run**: Always test new configurations in dry run mode
2. **Set Conservative Thresholds**: Begin with high relevance and confidence scores
3. **Monitor Alerts**: Use alerts to manually verify opportunities before enabling auto-trading
4. **Implement Gradually**: Start with one news source and platform, then expand
5. **Review Logs Regularly**: Check logs for errors and unexpected behavior
6. **Test Plugins Thoroughly**: Ensure new plugins handle errors gracefully

## Troubleshooting

### Common Issues

**Services not loading:**
- Check that service names in .env match plugin file names exactly
- Verify API keys are set correctly
- Check logs for initialization errors

**No opportunities found:**
- Lower relevance/confidence thresholds (carefully)
- Verify news sources are returning recent articles
- Check that LLM provider is working correctly

**Alerts not sending:**
- Verify SMTP settings for email alerts
- Check system notification permissions
- Review alert confidence threshold

**Configuration errors:**
- Run with `LOG_LEVEL=debug` for detailed output
- Verify all required environment variables are set
- Check for typos in service names

## Contributing

Contributions are welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Ensure all tests pass
5. Submit a pull request

## License

ISC