import {
  ContractValidator,
  ContractValidation,
  ContractWithContext,
  Contract,
  ParsedNewsInsight,
  LLMProvider,
} from '../../types';

interface LLMValidationResponse {
  isRelevant: boolean;
  relevanceScore: number;
  matchedEntities: string[];
  matchedEvents: string[];
  reasoning: string;
  suggestedPosition: 'buy' | 'sell' | 'hold';
  confidence: number;
  risks: string[];
  opportunities: string[];
}

interface BatchValidationResponse {
  contractId: string;
  isRelevant: boolean;
  relevanceScore: number;
  matchedEntities: string[];
  matchedEvents: string[];
  reasoning: string;
  suggestedPosition: 'buy' | 'sell' | 'hold';
  confidence: number;
  risks: string[];
  opportunities: string[];
}

export class ContractValidatorService implements ContractValidator {
  async validateContract(
    contract: Contract,
    newsInsight: ParsedNewsInsight,
    llmProvider: LLMProvider,
    marketTitle?: string,
    similarity?: number,
  ): Promise<ContractValidation> {
    const systemPrompt = `You are a prediction market analyst. Analyze betting contracts against news events.
You must respond with valid JSON matching the exact structure provided. Be precise about relevance and risk assessment.`;

    const displayTitle = marketTitle || contract.title;

    const prompt = `Analyze if this betting contract is relevant to the news and worth betting on.

MARKET QUESTION: ${displayTitle}
${similarity ? `(Semantic similarity to news: ${(similarity * 100).toFixed(1)}%)` : ''}

CONTRACT OPTION:
ID: ${contract.id}
Title: ${contract.title}
Yes Price: ${(contract.yesPrice * 100).toFixed(0)}% (cost to bet YES)
No Price: ${(contract.noPrice * 100).toFixed(0)}% (cost to bet NO)
Expires: ${contract.endDate ? new Date(contract.endDate).toISOString().split('T')[0] : 'Unknown'}
Volume: ${contract.volume || 'Unknown'}

NEWS INSIGHT:
Summary: ${newsInsight.summary}
Entities: ${newsInsight.entities.map((e) => `${e.name} (${e.type})`).join(', ') || 'None'}
Events: ${newsInsight.events.map((e) => `${e.description} (${e.impact} impact)`).join(', ') || 'None'}
Predictions: ${newsInsight.predictions.map((p) => `${p.outcome} (${(p.probability * 100).toFixed(0)}% likely)`).join(', ') || 'None'}
Sentiment: ${newsInsight.sentiment.overall > 0 ? 'Positive' : newsInsight.sentiment.overall < 0 ? 'Negative' : 'Neutral'} (${newsInsight.sentiment.overall.toFixed(2)})

Respond with this exact JSON structure:
{
  "isRelevant": true/false,
  "relevanceScore": 0.0-1.0,
  "matchedEntities": ["entity names from news that appear in contract"],
  "matchedEvents": ["events from news that relate to contract"],
  "reasoning": "2-3 sentences explaining the connection or lack thereof",
  "suggestedPosition": "buy" | "sell" | "hold",
  "confidence": 0.0-1.0,
  "risks": ["risk 1", "risk 2"],
  "opportunities": ["opportunity 1", "opportunity 2"]
}

Guidelines:
- isRelevant: true if the contract directly relates to entities/events in the news
- relevanceScore: how strongly the news impacts this specific contract (0=unrelated, 1=direct impact)
- suggestedPosition: "buy" if news suggests YES outcome more likely than current price implies, "sell" if NO more likely, "hold" if uncertain or fairly priced
- confidence: how confident you are in the suggested position (consider news reliability, time to expiry, market efficiency)
- Focus on actionable insights - is this a good bet given the news?

Return ONLY valid JSON, no additional text.`;

    try {
      const analysis = await llmProvider.generateCompletion(prompt, systemPrompt);
      const parsed = this.parseJSONResponse(analysis);

      return {
        contractId: contract.id,
        newsInsightId: newsInsight.originalNewsId,
        isRelevant: parsed.isRelevant,
        relevanceScore: this.clamp(parsed.relevanceScore, 0, 1),
        matchedEntities: parsed.matchedEntities || [],
        matchedEvents: parsed.matchedEvents || [],
        reasoning: parsed.reasoning || '',
        suggestedPosition: this.validatePosition(parsed.suggestedPosition),
        suggestedConfidence: this.clamp(parsed.confidence, 0, 1),
        risks: parsed.risks || [],
        opportunities: parsed.opportunities || [],
      };
    } catch (error) {
      console.error('Error validating contract with LLM:', error);
      return this.createFallbackValidation(contract, newsInsight);
    }
  }

  async batchValidateContracts(
    contractsWithContext: ContractWithContext[],
    newsInsight: ParsedNewsInsight,
    llmProvider: LLMProvider,
  ): Promise<ContractValidation[]> {
    if (contractsWithContext.length === 0) {
      return [];
    }

    // For small batches, process in a single LLM call
    if (contractsWithContext.length <= 10) {
      const results = await this.validateContractsInSingleRequest(
        contractsWithContext,
        newsInsight,
        llmProvider,
      );
      return results.sort((a, b) => b.relevanceScore - a.relevanceScore);
    }

    // For larger batches, chunk into groups of 10
    const results: ContractValidation[] = [];
    const batchSize = 10;

    for (let i = 0; i < contractsWithContext.length; i += batchSize) {
      const batch = contractsWithContext.slice(i, i + batchSize);
      try {
        const batchResults = await this.validateContractsInSingleRequest(
          batch,
          newsInsight,
          llmProvider,
        );
        results.push(...batchResults);
      } catch (error) {
        console.error(`Batch validation failed, falling back to individual:`, error);
        // Fallback to individual validation
        for (const item of batch) {
          const validation = await this.validateContract(
            item.contract,
            newsInsight,
            llmProvider,
            item.marketTitle,
            item.similarity,
          );
          results.push(validation);
        }
      }
    }

    return results.sort((a, b) => b.relevanceScore - a.relevanceScore);
  }

  private async validateContractsInSingleRequest(
    contractsWithContext: ContractWithContext[],
    newsInsight: ParsedNewsInsight,
    llmProvider: LLMProvider,
  ): Promise<ContractValidation[]> {
    const systemPrompt = `You are a prediction market analyst. Analyze multiple betting contracts against a single news event.
You must respond with a JSON array where each element matches the exact structure provided.`;

    const contractsList = contractsWithContext
      .map((item, i) => {
        const c = item.contract;
        return `[CONTRACT ${i + 1}]
ID: ${c.id}
Market: ${item.marketTitle}${item.similarity ? ` (${(item.similarity * 100).toFixed(0)}% similar)` : ''}
Option: ${c.title}
Yes: ${(c.yesPrice * 100).toFixed(0)}% / No: ${(c.noPrice * 100).toFixed(0)}%
Expires: ${c.endDate ? new Date(c.endDate).toISOString().split('T')[0] : 'Unknown'}`;
      })
      .join('\n\n');

    const prompt = `Analyze these ${contractsWithContext.length} betting contracts against the news insight.

NEWS INSIGHT:
Summary: ${newsInsight.summary}
Entities: ${newsInsight.entities.map((e) => `${e.name} (${e.type})`).join(', ') || 'None'}
Events: ${newsInsight.events.map((e) => `${e.description} (${e.impact} impact)`).join(', ') || 'None'}
Predictions: ${newsInsight.predictions.map((p) => `${p.outcome} (${(p.probability * 100).toFixed(0)}% likely)`).join(', ') || 'None'}
Sentiment: ${newsInsight.sentiment.overall > 0 ? 'Positive' : newsInsight.sentiment.overall < 0 ? 'Negative' : 'Neutral'}

CONTRACTS TO ANALYZE:
${contractsList}

Return a JSON array with ${contractsWithContext.length} objects, one per contract, in order:
[
  {
    "contractId": "the contract ID",
    "isRelevant": true/false,
    "relevanceScore": 0.0-1.0,
    "matchedEntities": ["matched entity names"],
    "matchedEvents": ["matched events"],
    "reasoning": "brief explanation",
    "suggestedPosition": "buy" | "sell" | "hold",
    "confidence": 0.0-1.0,
    "risks": ["risk factors"],
    "opportunities": ["opportunities"]
  }
]

Guidelines:
- Only mark contracts as relevant if they DIRECTLY relate to the news
- suggestedPosition: "buy" YES if news makes YES more likely than price suggests, "sell" (buy NO) if opposite, "hold" if uncertain
- Be selective - most contracts won't be relevant to any given news item

Return ONLY the JSON array, no additional text.`;

    try {
      const analysis = await llmProvider.generateCompletion(prompt, systemPrompt);
      const parsedArray = this.parseBatchJSONResponse(analysis);

      // Build a lookup map by contractId since LLM may return results in different order
      const parsedByContractId = new Map<string, BatchValidationResponse>();
      for (const parsed of parsedArray) {
        if (parsed.contractId) {
          parsedByContractId.set(parsed.contractId, parsed);
        }
      }

      // Map parsed results to ContractValidation objects
      const validations: ContractValidation[] = [];

      for (const item of contractsWithContext) {
        const contractId = item.contract.id;
        // Look up by contractId, fall back to empty response if not found
        const parsed = parsedByContractId.get(contractId) || this.createEmptyResponse(contractId);

        validations.push({
          contractId,
          newsInsightId: newsInsight.originalNewsId,
          isRelevant: parsed.isRelevant ?? false,
          relevanceScore: this.clamp(parsed.relevanceScore ?? 0, 0, 1),
          matchedEntities: parsed.matchedEntities || [],
          matchedEvents: parsed.matchedEvents || [],
          reasoning: parsed.reasoning || '',
          suggestedPosition: this.validatePosition(parsed.suggestedPosition),
          suggestedConfidence: this.clamp(parsed.confidence ?? 0, 0, 1),
          risks: parsed.risks || [],
          opportunities: parsed.opportunities || [],
        });
      }

      return validations;
    } catch (error) {
      console.error('Batch validation parsing failed:', error);
      throw error;
    }
  }

  private parseJSONResponse(response: string): LLMValidationResponse {
    let jsonStr = response.trim();

    // Handle markdown code blocks
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    }

    // Find JSON object boundaries
    const jsonStart = jsonStr.indexOf('{');
    const jsonEnd = jsonStr.lastIndexOf('}');
    if (jsonStart !== -1 && jsonEnd !== -1) {
      jsonStr = jsonStr.substring(jsonStart, jsonEnd + 1);
    }

    try {
      return JSON.parse(jsonStr) as LLMValidationResponse;
    } catch (error) {
      console.error('Failed to parse validation JSON:', error);
      console.error('Response was:', jsonStr.substring(0, 500));
      throw error;
    }
  }

  private parseBatchJSONResponse(response: string): BatchValidationResponse[] {
    let jsonStr = response.trim();

    // Handle markdown code blocks
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    }

    // Find array boundaries
    const arrayStart = jsonStr.indexOf('[');
    if (arrayStart === -1) {
      console.error('No JSON array found in batch response');
      return [];
    }

    // Find matching closing bracket
    let depth = 0;
    let arrayEnd = -1;
    let inString = false;
    let escapeNext = false;

    for (let i = arrayStart; i < jsonStr.length; i++) {
      const char = jsonStr[i];

      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      if (char === '\\') {
        escapeNext = true;
        continue;
      }

      if (char === '"' && !escapeNext) {
        inString = !inString;
        continue;
      }

      if (!inString) {
        if (char === '[' || char === '{') {
          depth++;
        } else if (char === ']' || char === '}') {
          depth--;
          if (depth === 0 && char === ']') {
            arrayEnd = i;
            break;
          }
        }
      }
    }

    if (arrayEnd === -1) {
      console.error('Malformed JSON array - no matching closing bracket');
      return [];
    }

    jsonStr = jsonStr.substring(arrayStart, arrayEnd + 1);

    try {
      const parsed = JSON.parse(jsonStr);
      if (!Array.isArray(parsed)) {
        console.error('Batch response is not an array');
        return [];
      }
      return parsed;
    } catch (error) {
      console.error('Failed to parse batch validation JSON:', error);
      console.error('Attempted to parse:', jsonStr.substring(0, 500));
      return [];
    }
  }

  private createEmptyResponse(contractId: string): BatchValidationResponse {
    return {
      contractId,
      isRelevant: false,
      relevanceScore: 0,
      matchedEntities: [],
      matchedEvents: [],
      reasoning: 'Failed to parse LLM response',
      suggestedPosition: 'hold',
      confidence: 0,
      risks: ['Analysis failed'],
      opportunities: [],
    };
  }

  private createFallbackValidation(
    contract: Contract,
    newsInsight: ParsedNewsInsight,
  ): ContractValidation {
    // Basic fallback using simple text matching
    const contractText = contract.title.toLowerCase();
    const matchedEntities = newsInsight.entities
      .filter((e) => contractText.includes(e.name.toLowerCase()))
      .map((e) => e.name);

    const matchedEvents = newsInsight.events
      .filter((e) => {
        const words = e.description.toLowerCase().split(' ');
        return words.some((w) => w.length > 4 && contractText.includes(w));
      })
      .map((e) => e.description);

    const isRelevant = matchedEntities.length > 0 || matchedEvents.length > 0;
    const relevanceScore = Math.min(matchedEntities.length * 0.3 + matchedEvents.length * 0.2, 1.0);

    return {
      contractId: contract.id,
      newsInsightId: newsInsight.originalNewsId,
      isRelevant,
      relevanceScore,
      matchedEntities,
      matchedEvents,
      reasoning: 'Fallback analysis based on keyword matching',
      suggestedPosition: 'hold',
      suggestedConfidence: relevanceScore * 0.5,
      risks: ['Analysis performed using fallback method - lower confidence'],
      opportunities: [],
    };
  }

  private validatePosition(position: unknown): 'buy' | 'sell' | 'hold' {
    if (position === 'buy' || position === 'sell' || position === 'hold') {
      return position;
    }
    return 'hold';
  }

  private clamp(value: number, min: number, max: number): number {
    if (typeof value !== 'number' || isNaN(value)) {
      return min;
    }
    return Math.max(min, Math.min(max, value));
  }
}
