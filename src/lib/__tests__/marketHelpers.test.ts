import { Contract } from '../../types';
import { deriveMarketTitle } from '../marketHelpers';

describe('marketHelpers', () => {
  describe('deriveMarketTitle', () => {
    const createContract = (title: string): Contract => ({
      id: `contract-${Math.random()}`,
      platform: 'test',
      title,
      yesPrice: 0.5,
      noPrice: 0.5,
      volume: 100,
      liquidity: 100,
      endDate: new Date(),
      tags: [],
      url: 'https://example.com',
      metadata: {},
    });

    it('should return "Unknown Market" for empty array', () => {
      expect(deriveMarketTitle([])).toBe('Unknown Market');
    });

    it('should return the single contract title for array with one item', () => {
      const contracts = [createContract('Some Market Title')];
      expect(deriveMarketTitle(contracts)).toBe('Some Market Title');
    });

    it('should extract common prefix from multiple contract titles', () => {
      const contracts = [
        createContract('Minnesota at Atlanta: Double Doubles: Rudy Gobert'),
        createContract('Minnesota at Atlanta: Double Doubles: Anthony Edwards'),
        createContract('Minnesota at Atlanta: Double Doubles: Jalen Johnson'),
      ];
      expect(deriveMarketTitle(contracts)).toBe('Minnesota at Atlanta: Double Doubles');
    });

    it('should handle titles with different separator patterns', () => {
      const contracts = [
        createContract('Bitcoin Price Above $100,000: Yes'),
        createContract('Bitcoin Price Above $100,000: No'),
      ];
      expect(deriveMarketTitle(contracts)).toBe('Bitcoin Price Above $100,000');
    });

    it('should handle Kalshi-style titles', () => {
      const contracts = [
        createContract("Runner-up top Spotify song: Weren't for the Wind"),
        createContract('Runner-up top Spotify song: Birds of a Feather'),
        createContract('Runner-up top Spotify song: A Bar Song'),
      ];
      expect(deriveMarketTitle(contracts)).toBe('Runner-up top Spotify song');
    });

    it('should fallback to first title when common prefix is too short', () => {
      const contracts = [createContract('Yes'), createContract('No')];
      expect(deriveMarketTitle(contracts)).toBe('Yes');
    });

    it('should handle trailing whitespace and separators', () => {
      // Common prefix is "Market Title - Option " -> cleans to "Market Title - Option"
      const contracts = [
        createContract('Market Title - Option A'),
        createContract('Market Title - Option B'),
      ];
      expect(deriveMarketTitle(contracts)).toBe('Market Title - Option');
    });

    it('should fallback to first title when cleaned prefix is too short', () => {
      // Common prefix "Market: " cleans to "Market" (6 chars < 10 threshold)
      // So falls back to first contract's title
      const contracts = [createContract('Market: A'), createContract('Market: B')];
      expect(deriveMarketTitle(contracts)).toBe('Market: A');
    });

    it('should use cleaned prefix when it meets minimum length', () => {
      // Common prefix is "Long Market Title: " -> cleans to "Long Market Title" (17 chars > 10)
      const contracts = [
        createContract('Long Market Title: Yes'),
        createContract('Long Market Title: No'),
      ];
      expect(deriveMarketTitle(contracts)).toBe('Long Market Title');
    });

    it('should remove partial word matches from prefix', () => {
      // Common prefix is "Orlando at Indiana: Double Doubles: Pa"
      // but "Pa" is a partial word match (Pascal/Paolo), so clean to remove it
      const contracts = [
        createContract('Orlando at Indiana: Double Doubles: Pascal Siakam'),
        createContract('Orlando at Indiana: Double Doubles: Paolo Banchero'),
      ];
      expect(deriveMarketTitle(contracts)).toBe('Orlando at Indiana: Double Doubles');
    });

    it('should handle names with same prefix letters', () => {
      const contracts = [
        createContract('NBA Game: Points Leader: Stephen Curry'),
        createContract('NBA Game: Points Leader: Seth Curry'),
      ];
      expect(deriveMarketTitle(contracts)).toBe('NBA Game: Points Leader');
    });

    it('should use marketTitle from metadata when available', () => {
      const createContractWithMetadata = (title: string, marketTitle: string): Contract => ({
        ...createContract(title),
        metadata: { marketTitle },
      });

      const contracts = [
        createContractWithMetadata('Washington St.', 'Loyola Marymount at Washington St. Winner?'),
        createContractWithMetadata(
          'Loyola Marymount',
          'Loyola Marymount at Washington St. Winner?',
        ),
      ];
      expect(deriveMarketTitle(contracts)).toBe('Loyola Marymount at Washington St. Winner?');
    });

    it('should use marketTitle for single contract with metadata', () => {
      const contract: Contract = {
        ...createContract('Washington St.'),
        metadata: { marketTitle: 'Loyola Marymount at Washington St. Winner?' },
      };
      expect(deriveMarketTitle([contract])).toBe('Loyola Marymount at Washington St. Winner?');
    });

    it('should fallback to common prefix when no marketTitle in metadata', () => {
      const contracts = [
        createContract('Bitcoin Price Above $100,000: Yes'),
        createContract('Bitcoin Price Above $100,000: No'),
      ];
      // No marketTitle in metadata, so should use common prefix
      expect(deriveMarketTitle(contracts)).toBe('Bitcoin Price Above $100,000');
    });
  });
});
