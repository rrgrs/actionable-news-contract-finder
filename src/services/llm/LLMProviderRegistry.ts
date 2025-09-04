import { LLMProvider, LLMProviderConfig, LLMProviderPlugin } from '../../types';

export class LLMProviderRegistry {
  private static plugins = new Map<string, LLMProviderPlugin>();
  private static instances = new Map<string, LLMProvider>();

  static registerPlugin(name: string, plugin: LLMProviderPlugin): void {
    if (this.plugins.has(name)) {
      throw new Error(`LLM provider plugin '${name}' is already registered`);
    }
    this.plugins.set(name, plugin);
    console.log(`Registered LLM provider plugin: ${name}`);
  }

  static unregisterPlugin(name: string): void {
    this.plugins.delete(name);
    console.log(`Unregistered LLM provider plugin: ${name}`);
  }

  static async createProvider(config: LLMProviderConfig): Promise<LLMProvider> {
    const plugin = this.plugins.get(config.name);
    if (!plugin) {
      throw new Error(
        `LLM provider plugin '${config.name}' not found. Available plugins: ${Array.from(this.plugins.keys()).join(', ')}`,
      );
    }

    const provider = plugin.create(config);
    await provider.initialize(config);

    const instanceKey = `${config.name}_${Date.now()}`;
    this.instances.set(instanceKey, provider);

    return provider;
  }

  static getAvailablePlugins(): string[] {
    return Array.from(this.plugins.keys());
  }

  static async destroyAllProviders(): Promise<void> {
    for (const provider of this.instances.values()) {
      await provider.destroy();
    }
    this.instances.clear();
  }
}
