import { NewsService, NewsServiceConfig, NewsServicePlugin } from '../../types';

export class NewsServiceRegistry {
  private static plugins = new Map<string, NewsServicePlugin>();
  private static instances = new Map<string, NewsService>();

  static registerPlugin(name: string, plugin: NewsServicePlugin): void {
    if (this.plugins.has(name)) {
      throw new Error(`News service plugin '${name}' is already registered`);
    }
    this.plugins.set(name, plugin);
    console.log(`Registered news service plugin: ${name}`);
  }

  static unregisterPlugin(name: string): void {
    this.plugins.delete(name);
    console.log(`Unregistered news service plugin: ${name}`);
  }

  static async createService(config: NewsServiceConfig): Promise<NewsService> {
    const plugin = this.plugins.get(config.name);
    if (!plugin) {
      throw new Error(
        `News service plugin '${config.name}' not found. Available plugins: ${Array.from(this.plugins.keys()).join(', ')}`,
      );
    }

    const service = plugin.create(config);
    await service.initialize(config);

    const instanceKey = `${config.name}_${Date.now()}`;
    this.instances.set(instanceKey, service);

    return service;
  }

  static getAvailablePlugins(): string[] {
    return Array.from(this.plugins.keys());
  }

  static async destroyAllServices(): Promise<void> {
    for (const service of this.instances.values()) {
      await service.destroy();
    }
    this.instances.clear();
  }
}
