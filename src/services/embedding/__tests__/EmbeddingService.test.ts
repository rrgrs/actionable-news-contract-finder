import axios from 'axios';
import { EmbeddingService } from '../EmbeddingService';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('EmbeddingService', () => {
  let service: EmbeddingService;

  beforeEach(() => {
    jest.clearAllMocks();

    mockedAxios.create.mockReturnValue({
      post: mockedAxios.post,
      get: mockedAxios.get,
    } as unknown as ReturnType<typeof axios.create>);

    service = new EmbeddingService({
      apiKey: 'test-api-key',
      model: 'text-embedding-004',
      batchSize: 10,
      requestDelayMs: 0, // No delay in tests
    });
  });

  describe('generateEmbedding', () => {
    it('should generate embedding for a single text', async () => {
      const mockEmbedding = Array(768).fill(0.1);
      mockedAxios.post.mockResolvedValueOnce({
        data: {
          embedding: {
            values: mockEmbedding,
          },
        },
      });

      const result = await service.generateEmbedding('test text');

      expect(result).toEqual(mockEmbedding);
      expect(result.length).toBe(768);
      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.stringContaining('/models/text-embedding-004:embedContent'),
        expect.objectContaining({
          model: 'models/text-embedding-004',
          content: {
            parts: [{ text: 'test text' }],
          },
        }),
      );
    });

    it('should throw error when no embedding returned', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: {},
      });

      await expect(service.generateEmbedding('test')).rejects.toThrow(
        'No embedding returned from Gemini',
      );
    });

    it('should handle API errors', async () => {
      const axiosError = {
        isAxiosError: true,
        response: {
          status: 400,
          data: {
            error: {
              message: 'Invalid request',
            },
          },
        },
      };
      mockedAxios.post.mockRejectedValueOnce(axiosError);
      // Use Object.defineProperty to mock isAxiosError properly
      Object.defineProperty(axios, 'isAxiosError', {
        value: jest.fn().mockReturnValue(true),
        writable: true,
      });

      await expect(service.generateEmbedding('test')).rejects.toThrow('Gemini embedding error');
    });
  });

  describe('generateEmbeddings (batch)', () => {
    it('should generate embeddings for multiple texts', async () => {
      const mockEmbeddings = [Array(768).fill(0.1), Array(768).fill(0.2), Array(768).fill(0.3)];

      mockedAxios.post.mockResolvedValueOnce({
        data: {
          embeddings: mockEmbeddings.map((values) => ({ values })),
        },
      });

      const texts = ['text1', 'text2', 'text3'];
      const result = await service.generateEmbeddings(texts);

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual(mockEmbeddings[0]);
      expect(result[1]).toEqual(mockEmbeddings[1]);
      expect(result[2]).toEqual(mockEmbeddings[2]);
    });

    it('should batch requests when texts exceed batch size', async () => {
      // Create service with small batch size
      const smallBatchService = new EmbeddingService({
        apiKey: 'test-api-key',
        batchSize: 2,
        requestDelayMs: 0,
      });

      const mockEmbedding = Array(768).fill(0.1);

      // First batch
      mockedAxios.post.mockResolvedValueOnce({
        data: {
          embeddings: [{ values: mockEmbedding }, { values: mockEmbedding }],
        },
      });

      // Second batch
      mockedAxios.post.mockResolvedValueOnce({
        data: {
          embeddings: [{ values: mockEmbedding }],
        },
      });

      const texts = ['text1', 'text2', 'text3'];
      const result = await smallBatchService.generateEmbeddings(texts);

      expect(result).toHaveLength(3);
      expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    });
  });

  describe('cosineSimilarity', () => {
    it('should calculate cosine similarity correctly', () => {
      const a = [1, 0, 0];
      const b = [1, 0, 0];
      expect(EmbeddingService.cosineSimilarity(a, b)).toBeCloseTo(1.0);
    });

    it('should return 0 for orthogonal vectors', () => {
      const a = [1, 0, 0];
      const b = [0, 1, 0];
      expect(EmbeddingService.cosineSimilarity(a, b)).toBeCloseTo(0.0);
    });

    it('should return -1 for opposite vectors', () => {
      const a = [1, 0, 0];
      const b = [-1, 0, 0];
      expect(EmbeddingService.cosineSimilarity(a, b)).toBeCloseTo(-1.0);
    });

    it('should handle vectors of different lengths', () => {
      const a = [1, 0];
      const b = [1, 0, 0];
      expect(EmbeddingService.cosineSimilarity(a, b)).toBe(0);
    });

    it('should handle empty vectors', () => {
      expect(EmbeddingService.cosineSimilarity([], [])).toBe(0);
    });

    it('should handle zero vectors', () => {
      const a = [0, 0, 0];
      const b = [1, 0, 0];
      expect(EmbeddingService.cosineSimilarity(a, b)).toBe(0);
    });
  });

  describe('findTopSimilar', () => {
    it('should find top N similar items', () => {
      const queryEmbedding = [1, 0, 0];
      const items = [
        { item: 'A', embedding: [1, 0, 0] }, // similarity = 1.0
        { item: 'B', embedding: [0.9, 0.1, 0] }, // similarity ~ 0.99
        { item: 'C', embedding: [0, 1, 0] }, // similarity = 0
        { item: 'D', embedding: [0.5, 0.5, 0] }, // similarity ~ 0.71
      ];

      const result = EmbeddingService.findTopSimilar(queryEmbedding, items, 2);

      expect(result).toHaveLength(2);
      expect(result[0].item).toBe('A');
      expect(result[0].similarity).toBeCloseTo(1.0);
      expect(result[1].item).toBe('B');
    });

    it('should return all items if topN exceeds available items', () => {
      const queryEmbedding = [1, 0, 0];
      const items = [
        { item: 'A', embedding: [1, 0, 0] },
        { item: 'B', embedding: [0, 1, 0] },
      ];

      const result = EmbeddingService.findTopSimilar(queryEmbedding, items, 10);

      expect(result).toHaveLength(2);
    });

    it('should handle empty items array', () => {
      const result = EmbeddingService.findTopSimilar([1, 0, 0], [], 5);
      expect(result).toHaveLength(0);
    });
  });
});
