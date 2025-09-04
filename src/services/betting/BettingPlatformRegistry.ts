import { BettingPlatform, BettingPlatformConfig, BettingPlatformPlugin } from '../../types';

export class BettingPlatformRegistry {
  private static plugins = new Map<string, BettingPlatformPlugin>();
  private static instances = new Map<string, BettingPlatform>();

  static registerPlugin(name: string, plugin: BettingPlatformPlugin): void {
    if (this.plugins.has(name)) {
      throw new Error(`Betting platform plugin '${name}' is already registered`);
    }
    this.plugins.set(name, plugin);
    console.log(`Registered betting platform plugin: ${name}`);
  }

  static unregisterPlugin(name: string): void {
    this.plugins.delete(name);
    console.log(`Unregistered betting platform plugin: ${name}`);
  }

  static async createPlatform(config: BettingPlatformConfig): Promise<BettingPlatform> {
    const plugin = this.plugins.get(config.name);
    if (!plugin) {
      throw new Error(
        `Betting platform plugin '${config.name}' not found. Available plugins: ${Array.from(this.plugins.keys()).join(', ')}`,
      );
    }

    const platform = plugin.create(config);
    await platform.initialize(config);

    const instanceKey = `${config.name}_${Date.now()}`;
    this.instances.set(instanceKey, platform);

    return platform;
  }

  static getAvailablePlugins(): string[] {
    return Array.from(this.plugins.keys());
  }

  static async destroyAllPlatforms(): Promise<void> {
    for (const platform of this.instances.values()) {
      await platform.destroy();
    }
    this.instances.clear();
  }
}
