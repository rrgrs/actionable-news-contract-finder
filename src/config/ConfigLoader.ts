import * as fs from 'fs';
import * as path from 'path';
import { AppConfig, ServiceConfig, AlertConfig, AlertType } from './types';
import {
  NewsServicePlugin,
  BettingPlatformPlugin,
  LLMProviderPlugin,
  NewsServiceConfig,
  BettingPlatformConfig,
  LLMProviderConfig,
} from '../types';

export class ConfigLoader {
  private static parseServiceList(envVar: string | undefined): string[] {
    if (!envVar || envVar.trim() === '') {
      return [];
    }
    return envVar
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  private static parseAlertConfig(): AlertConfig {
    const alertType = (process.env.ALERT_TYPE || 'none').toLowerCase() as AlertType;

    // Validate alert type
    if (!['none', 'email', 'system', 'both'].includes(alertType)) {
      console.warn(`Invalid ALERT_TYPE '${alertType}', using 'none'`);
      return { type: 'none' };
    }

    const config: AlertConfig = {
      type: alertType,
      minConfidenceThreshold: process.env.ALERT_MIN_CONFIDENCE
        ? parseFloat(process.env.ALERT_MIN_CONFIDENCE)
        : 0.7,
      cooldownMinutes: process.env.ALERT_COOLDOWN_MINUTES
        ? parseInt(process.env.ALERT_COOLDOWN_MINUTES)
        : 30,
    };

    // Parse email configuration if needed
    if (alertType === 'email' || alertType === 'both') {
      const emailTo = process.env.ALERT_EMAIL_TO;
      if (!emailTo) {
        console.warn('Email alerts configured but ALERT_EMAIL_TO not set');
      }

      config.emailConfig = {
        to: emailTo ? emailTo.split(',').map((e) => e.trim()) : [],
        from: process.env.ALERT_EMAIL_FROM || 'alerts@actionable-news.com',
        smtpHost: process.env.ALERT_SMTP_HOST,
        smtpPort: process.env.ALERT_SMTP_PORT ? parseInt(process.env.ALERT_SMTP_PORT) : undefined,
        smtpUser: process.env.ALERT_SMTP_USER,
        smtpPass: process.env.ALERT_SMTP_PASS,
      };
    }

    return config;
  }

  private static async discoverPlugins(
    servicePath: string,
  ): Promise<{ fileName: string; exportName: string }[]> {
    const plugins: { fileName: string; exportName: string }[] = [];
    const pluginsPath = path.join(servicePath, 'plugins');

    if (!fs.existsSync(pluginsPath)) {
      return plugins;
    }

    const files = fs.readdirSync(pluginsPath);

    for (const file of files) {
      if (file.endsWith('.js') || file.endsWith('.ts')) {
        const fullPath = path.join(pluginsPath, file);

        // Skip test files and type definition files
        if (file.includes('.test.') || file.includes('.spec.') || file.endsWith('.d.ts')) {
          continue;
        }

        try {
          const module = await import(path.resolve(fullPath));

          // Find exports that end with 'Plugin'
          for (const exportName of Object.keys(module)) {
            if (exportName.endsWith('Plugin')) {
              plugins.push({
                fileName: file.replace(/\.(js|ts)$/, ''),
                exportName,
              });
            }
          }
        } catch {
          // Skip files that can't be imported
          continue;
        }
      }
    }

    return plugins;
  }

  private static parseServiceConfig(serviceName: string, prefix: string): Record<string, any> {
    const config: Record<string, any> = {};
    const envPrefix = `${prefix}_${serviceName.toUpperCase().replace(/-/g, '_')}_`;

    // Collect all env vars that start with the service prefix
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith(envPrefix)) {
        const configKey = key.substring(envPrefix.length).toLowerCase();
        config[configKey] = value;
      }
    }

    return config;
  }

  static loadConfig(): AppConfig {
    const newsServices = this.parseServiceList(process.env.NEWS_SERVICES);
    const bettingPlatforms = this.parseServiceList(process.env.BETTING_PLATFORMS);
    const llmProviders = this.parseServiceList(process.env.LLM_PROVIDERS);

    if (newsServices.length === 0) {
      console.warn('No news services configured, using mock-news');
      newsServices.push('mock-news');
    }

    if (bettingPlatforms.length === 0) {
      console.warn('No betting platforms configured, using mock-betting');
      bettingPlatforms.push('mock-betting');
    }

    if (llmProviders.length === 0) {
      console.warn('No LLM providers configured, using mock-llm');
      llmProviders.push('mock-llm');
    }

    return {
      newsServices: newsServices.map((name) => ({
        name,
        fileName: name.replace(/-/g, ''),
        config: {
          name,
          ...this.parseServiceConfig(name, 'NEWS'),
        },
      })),
      bettingPlatforms: bettingPlatforms.map((name) => ({
        name,
        fileName: name.replace(/-/g, ''),
        config: {
          name,
          ...this.parseServiceConfig(name, 'BETTING'),
        },
      })),
      llmProviders: llmProviders.map((name) => ({
        name,
        fileName: name.replace(/-/g, ''),
        config: {
          name,
          ...this.parseServiceConfig(name, 'LLM'),
        },
      })),
      orchestrator: {
        pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '60000'),
        minRelevanceScore: parseFloat(process.env.MIN_RELEVANCE_SCORE || '0.5'),
        minConfidenceScore: parseFloat(process.env.MIN_CONFIDENCE_SCORE || '0.6'),
        maxPositionsPerContract: parseInt(process.env.MAX_POSITIONS_PER_CONTRACT || '3'),
        dryRun: process.env.DRY_RUN !== 'false',
        placeBets: process.env.PLACE_BETS === 'true', // Default to false for safety
      },
      alerts: this.parseAlertConfig(),
      logLevel: process.env.LOG_LEVEL || 'info',
    };
  }

  static async findAndLoadPlugin<T>(
    servicePath: string,
    serviceConfig: ServiceConfig,
  ): Promise<{ plugin: T; exportName: string }> {
    const pluginsPath = path.join(servicePath, 'plugins');

    // Discover all available plugins
    const availablePlugins = await this.discoverPlugins(servicePath);

    // Try to find a plugin that matches the service name
    // We'll try multiple matching strategies
    const searchPatterns = [
      serviceConfig.name.toLowerCase(),
      serviceConfig.fileName.toLowerCase(),
      serviceConfig.name.toLowerCase().replace(/-/g, ''),
      serviceConfig.fileName.toLowerCase().replace(/-/g, ''),
    ];

    let matchedPlugin: { fileName: string; exportName: string } | null = null;

    // Try to find exact or partial matches
    for (const pattern of searchPatterns) {
      for (const plugin of availablePlugins) {
        const pluginNameLower = plugin.fileName.toLowerCase();
        const exportNameLower = plugin.exportName.toLowerCase();

        // Check if the plugin file or export name contains our pattern
        if (
          pluginNameLower.includes(pattern) ||
          exportNameLower.includes(pattern.replace(/-/g, ''))
        ) {
          matchedPlugin = plugin;
          break;
        }
      }
      if (matchedPlugin) {
        break;
      }
    }

    if (!matchedPlugin) {
      const availableList = availablePlugins
        .map((p) => `  - ${p.exportName} (from ${p.fileName})`)
        .join('\n');

      throw new Error(
        `No plugin found for service '${serviceConfig.name}'.\n` +
          `Available plugins in ${pluginsPath}:\n${availableList || '  (none)'}\n\n` +
          `To use a plugin, set the service name in .env to match one of the available plugins.`,
      );
    }

    // Load the matched plugin
    const modulePath = path.join(pluginsPath, `${matchedPlugin.fileName}.js`);
    const tsModulePath = path.join(pluginsPath, `${matchedPlugin.fileName}.ts`);
    const fullPath = fs.existsSync(modulePath) ? modulePath : tsModulePath;

    const module = await import(path.resolve(fullPath));
    const plugin = module[matchedPlugin.exportName];

    if (!plugin) {
      throw new Error(`Export '${matchedPlugin.exportName}' not found in ${fullPath}`);
    }

    return { plugin: plugin as T, exportName: matchedPlugin.exportName };
  }

  static async validateConfiguration(config: AppConfig): Promise<void> {
    const errors: string[] = [];

    // Validate news services
    for (const service of config.newsServices) {
      try {
        const result = await this.findAndLoadPlugin<NewsServicePlugin>(
          path.join(__dirname, '../services/news'),
          service,
        );
        console.log(`✓ News service '${service.name}' validated (using ${result.exportName})`);
      } catch (error) {
        errors.push(
          `News service '${service.name}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Validate betting platforms
    for (const platform of config.bettingPlatforms) {
      try {
        const result = await this.findAndLoadPlugin<BettingPlatformPlugin>(
          path.join(__dirname, '../services/betting'),
          platform,
        );
        console.log(`✓ Betting platform '${platform.name}' validated (using ${result.exportName})`);
      } catch (error) {
        errors.push(
          `Betting platform '${platform.name}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Validate LLM providers
    for (const provider of config.llmProviders) {
      try {
        const result = await this.findAndLoadPlugin<LLMProviderPlugin>(
          path.join(__dirname, '../services/llm'),
          provider,
        );
        console.log(`✓ LLM provider '${provider.name}' validated (using ${result.exportName})`);
      } catch (error) {
        errors.push(
          `LLM provider '${provider.name}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (errors.length > 0) {
      throw new Error(
        'Configuration validation failed:\n' + errors.map((e) => `  - ${e}`).join('\n'),
      );
    }

    console.log('\n✅ All configured services validated successfully\n');
  }

  static async loadAndRegisterServices(
    config: AppConfig,
    newsRegistry: any,
    bettingRegistry: any,
    llmRegistry: any,
  ): Promise<{
    newsServices: any[];
    bettingPlatforms: any[];
    llmProviders: any[];
  }> {
    const newsServices = [];
    const bettingPlatforms = [];
    const llmProviders = [];

    // Register and create news services
    for (const serviceConfig of config.newsServices) {
      const result = await this.findAndLoadPlugin<NewsServicePlugin>(
        path.join(__dirname, '../services/news'),
        serviceConfig,
      );

      newsRegistry.registerPlugin(serviceConfig.name, result.plugin);
      const service = await newsRegistry.createService(serviceConfig.config as NewsServiceConfig);
      newsServices.push(service);
      console.log(`📰 Loaded news service: ${serviceConfig.name} (${result.exportName})`);
    }

    // Register and create betting platforms
    for (const platformConfig of config.bettingPlatforms) {
      const result = await this.findAndLoadPlugin<BettingPlatformPlugin>(
        path.join(__dirname, '../services/betting'),
        platformConfig,
      );

      bettingRegistry.registerPlugin(platformConfig.name, result.plugin);
      const platform = await bettingRegistry.createPlatform(
        platformConfig.config as BettingPlatformConfig,
      );
      bettingPlatforms.push(platform);
      console.log(`🎲 Loaded betting platform: ${platformConfig.name} (${result.exportName})`);
    }

    // Register and create LLM providers
    for (const providerConfig of config.llmProviders) {
      const result = await this.findAndLoadPlugin<LLMProviderPlugin>(
        path.join(__dirname, '../services/llm'),
        providerConfig,
      );

      llmRegistry.registerPlugin(providerConfig.name, result.plugin);
      const provider = await llmRegistry.createProvider(providerConfig.config as LLMProviderConfig);
      llmProviders.push(provider);
      console.log(`🤖 Loaded LLM provider: ${providerConfig.name} (${result.exportName})`);
    }

    return { newsServices, bettingPlatforms, llmProviders };
  }
}
