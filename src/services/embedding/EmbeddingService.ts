import axios, { AxiosInstance } from 'axios';
import { createLogger } from '../../utils/logger';

export interface EmbeddingConfig {
  apiKey: string;
  model?: string;
  batchSize?: number;
  requestDelayMs?: number;
}

interface GeminiEmbeddingRequest {
  model: string;
  content: {
    parts: Array<{ text: string }>;
  };
}

interface GeminiEmbeddingResponse {
  embedding: {
    values: number[];
  };
}

interface GeminiBatchEmbeddingRequest {
  requests: Array<{
    model: string;
    content: {
      parts: Array<{ text: string }>;
    };
  }>;
}

interface GeminiBatchEmbeddingResponse {
  embeddings: Array<{
    values: number[];
  }>;
}

/**
 * Service for generating text embeddings using Google Gemini.
 * Uses text-embedding-004 model which returns 768-dimensional vectors.
 */
export class EmbeddingService {
  private client: AxiosInstance;
  private apiKey: string;
  private model: string;
  private batchSize: number;
  private requestDelayMs: number;
  private lastRequestTime = 0;
  private logger = createLogger('EmbeddingService');

  constructor(config: EmbeddingConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model || 'text-embedding-004';
    this.batchSize = config.batchSize || 50; // Reduced from 100 for more reliable processing
    this.requestDelayMs = config.requestDelayMs || 100; // Rate limiting delay

    this.client = axios.create({
      baseURL: 'https://generativelanguage.googleapis.com/v1beta',
      timeout: 60000, // 60 seconds for batch embedding requests
    });

    this.logger.info('EmbeddingService initialized', {
      model: this.model,
      batchSize: this.batchSize,
    });
  }

  /**
   * Generate embedding for a single text
   */
  async generateEmbedding(text: string): Promise<number[]> {
    await this.enforceRateLimit();

    try {
      const request: GeminiEmbeddingRequest = {
        model: `models/${this.model}`,
        content: {
          parts: [{ text }],
        },
      };

      const response = await this.client.post<GeminiEmbeddingResponse>(
        `/models/${this.model}:embedContent?key=${this.apiKey}`,
        request,
      );

      if (response.data.embedding?.values) {
        return response.data.embedding.values;
      }

      throw new Error('No embedding returned from Gemini');
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 429) {
          this.logger.warn('Rate limit hit, waiting before retry...');
          await this.sleep(60000); // Wait 1 minute
          return this.generateEmbedding(text);
        }
        throw new Error(
          `Gemini embedding error: ${error.response?.data?.error?.message || error.message}`,
        );
      }
      throw error;
    }
  }

  /**
   * Generate embeddings for multiple texts in batches
   */
  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    const allEmbeddings: number[][] = [];

    // Process in batches
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);

      try {
        const batchEmbeddings = await this.generateBatchEmbeddings(batch);
        allEmbeddings.push(...batchEmbeddings);

        this.logger.debug('Batch embedding complete', {
          batchIndex: Math.floor(i / this.batchSize) + 1,
          totalBatches: Math.ceil(texts.length / this.batchSize),
          textsProcessed: allEmbeddings.length,
        });
      } catch (error) {
        // Fallback to individual embedding if batch fails
        this.logger.warn('Batch embedding failed, falling back to individual', {
          error: error instanceof Error ? error.message : String(error),
        });

        for (const text of batch) {
          try {
            const embedding = await this.generateEmbedding(text);
            allEmbeddings.push(embedding);
          } catch (individualError) {
            this.logger.error('Failed to generate individual embedding', {
              error:
                individualError instanceof Error
                  ? individualError.message
                  : String(individualError),
            });
            // Push empty embedding as placeholder
            allEmbeddings.push([]);
          }
        }
      }
    }

    return allEmbeddings;
  }

  /**
   * Generate embeddings for a batch of texts (internal method)
   */
  private async generateBatchEmbeddings(texts: string[]): Promise<number[][]> {
    await this.enforceRateLimit();

    try {
      const request: GeminiBatchEmbeddingRequest = {
        requests: texts.map((text) => ({
          model: `models/${this.model}`,
          content: {
            parts: [{ text }],
          },
        })),
      };

      const response = await this.client.post<GeminiBatchEmbeddingResponse>(
        `/models/${this.model}:batchEmbedContents?key=${this.apiKey}`,
        request,
      );

      if (response.data.embeddings) {
        return response.data.embeddings.map((e) => e.values);
      }

      throw new Error('No embeddings returned from Gemini batch request');
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 429) {
          this.logger.warn('Rate limit hit on batch, waiting before retry...');
          await this.sleep(60000);
          return this.generateBatchEmbeddings(texts);
        }
        throw new Error(
          `Gemini batch embedding error: ${error.response?.data?.error?.message || error.message}`,
        );
      }
      throw error;
    }
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  static cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) {
      return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    if (magnitude === 0) {
      return 0;
    }

    return dotProduct / magnitude;
  }

  /**
   * Find top N most similar items based on cosine similarity
   */
  static findTopSimilar<T>(
    queryEmbedding: number[],
    items: Array<{ item: T; embedding: number[] }>,
    topN: number,
  ): Array<{ item: T; similarity: number }> {
    const scored = items
      .map(({ item, embedding }) => ({
        item,
        similarity: EmbeddingService.cosineSimilarity(queryEmbedding, embedding),
      }))
      .sort((a, b) => b.similarity - a.similarity);

    return scored.slice(0, topN);
  }

  private async enforceRateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    if (timeSinceLastRequest < this.requestDelayMs) {
      await this.sleep(this.requestDelayMs - timeSinceLastRequest);
    }

    this.lastRequestTime = Date.now();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
