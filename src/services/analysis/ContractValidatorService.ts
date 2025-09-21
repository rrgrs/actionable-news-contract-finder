import {
  ContractValidator,
  ContractValidation,
  Contract,
  ParsedNewsInsight,
  LLMProvider,
} from '../../types';

export class ContractValidatorService implements ContractValidator {
  async validateContract(
    contract: Contract,
    newsInsight: ParsedNewsInsight,
    llmProvider: LLMProvider,
  ): Promise<ContractValidation> {
    const systemPrompt = `You are a prediction market analyst. Determine if a betting contract is relevant to a news event.
Analyze the connection between news insights and contract terms. Be precise about relevance and risk assessment.`;

    const prompt = `Analyze if this contract matches the news insight:

CONTRACT:
Title: ${contract.title}
Description: ${contract.description}
Yes Price: ${contract.yesPrice}
No Price: ${contract.noPrice}
Expires: ${contract.endDate}

NEWS INSIGHT:
Summary: ${newsInsight.summary}
Entities: ${newsInsight.entities.map((e) => e.name).join(', ')}
Events: ${newsInsight.events.map((e) => e.description).join(', ')}
Predictions: ${newsInsight.predictions.map((p) => p.outcome).join(', ')}
Suggested Actions: ${newsInsight.suggestedActions.map((a) => a.description).join(', ')}

Determine:
1. Is this contract relevant to the news? (yes/no and why)
2. Relevance score (0-1)
3. Which entities/events match?
4. Suggested position (buy/sell/hold)
5. Confidence level
6. Key risks
7. Opportunities`;

    const analysis = await llmProvider.generateCompletion(prompt, systemPrompt);

    return this.parseValidationResponse(contract, newsInsight, analysis);
  }

  async batchValidateContracts(
    contracts: Contract[],
    newsInsight: ParsedNewsInsight,
    llmProvider: LLMProvider,
  ): Promise<ContractValidation[]> {
    const validations = await Promise.all(
      contracts.map((contract) => this.validateContract(contract, newsInsight, llmProvider)),
    );

    return validations.sort((a, b) => b.relevanceScore - a.relevanceScore);
  }

  private parseValidationResponse(
    contract: Contract,
    newsInsight: ParsedNewsInsight,
    analysis: string,
  ): ContractValidation {
    const isRelevant = this.checkRelevance(contract, newsInsight, analysis);
    const relevanceScore = this.calculateRelevanceScore(contract, newsInsight, analysis);
    const matchedEntities = this.findMatchedEntities(contract, newsInsight);
    const matchedEvents = this.findMatchedEvents(contract, newsInsight);

    return {
      contractId: contract.id,
      newsInsightId: newsInsight.originalNewsId,
      isRelevant,
      relevanceScore,
      matchedEntities,
      matchedEvents,
      reasoning: this.extractReasoning(analysis),
      suggestedPosition: this.determineSuggestedPosition(contract, newsInsight, analysis),
      suggestedConfidence: this.calculateConfidence(
        relevanceScore,
        matchedEntities.length,
        matchedEvents.length,
      ),
      risks: this.identifyRisks(contract, newsInsight, analysis),
      opportunities: this.identifyOpportunities(contract, newsInsight, analysis),
    };
  }

  private checkRelevance(
    contract: Contract,
    newsInsight: ParsedNewsInsight,
    analysis: string,
  ): boolean {
    const contractText = `${contract.title} ${contract.description}`.toLowerCase();

    for (const entity of newsInsight.entities) {
      if (contractText.includes(entity.name.toLowerCase())) {
        return true;
      }
    }

    for (const event of newsInsight.events) {
      const eventWords = event.description.toLowerCase().split(' ');
      if (eventWords.some((word) => contractText.includes(word))) {
        return true;
      }
    }

    if (
      analysis.toLowerCase().includes('relevant') &&
      !analysis.toLowerCase().includes('not relevant')
    ) {
      return true;
    }

    return false;
  }

  private calculateRelevanceScore(
    contract: Contract,
    newsInsight: ParsedNewsInsight,
    analysis: string,
  ): number {
    let score = 0;
    const contractText = `${contract.title} ${contract.description}`.toLowerCase();

    newsInsight.entities.forEach((entity) => {
      if (contractText.includes(entity.name.toLowerCase())) {
        score += 0.3 * entity.confidence;
      }
    });

    newsInsight.events.forEach((event) => {
      if (contractText.includes(event.type)) {
        score += 0.2;
      }
    });

    newsInsight.suggestedActions.forEach((action) => {
      if (
        action.relatedMarketQuery &&
        contractText.includes(action.relatedMarketQuery.toLowerCase())
      ) {
        score += 0.2 * action.confidence;
      }
    });

    if (analysis.includes('highly relevant')) {
      score += 0.2;
    }
    if (analysis.includes('direct correlation')) {
      score += 0.15;
    }

    return Math.min(score, 1.0);
  }

  private findMatchedEntities(contract: Contract, newsInsight: ParsedNewsInsight): string[] {
    const contractText = `${contract.title} ${contract.description}`.toLowerCase();
    return newsInsight.entities
      .filter((entity) => contractText.includes(entity.name.toLowerCase()))
      .map((entity) => entity.name);
  }

  private findMatchedEvents(contract: Contract, newsInsight: ParsedNewsInsight): string[] {
    const contractText = `${contract.title} ${contract.description}`.toLowerCase();
    return newsInsight.events
      .filter((event) => {
        const eventWords = event.description.toLowerCase().split(' ');
        return eventWords.some((word) => word.length > 3 && contractText.includes(word));
      })
      .map((event) => event.description);
  }

  private extractReasoning(analysis: string): string {
    if (analysis.includes('relevant')) {
      const sentences = analysis.split('.');
      const relevantSentence = sentences.find((s) => s.includes('relevant')) || '';
      return relevantSentence.trim();
    }
    return 'Contract relevance determined by entity and event matching';
  }

  private determineSuggestedPosition(
    contract: Contract,
    newsInsight: ParsedNewsInsight,
    analysis: string,
  ): 'buy' | 'sell' | 'hold' {
    // Check if sentiment aligns with underpriced outcomes
    if (newsInsight.sentiment.overall > 0.3 && contract.yesPrice < 0.6) {
      return 'buy';
    }
    if (newsInsight.sentiment.overall < -0.3 && contract.noPrice < 0.6) {
      return 'buy';
    }

    if (analysis.toLowerCase().includes('buy')) {
      return 'buy';
    }
    if (analysis.toLowerCase().includes('sell')) {
      return 'sell';
    }

    return 'hold';
  }

  private calculateConfidence(
    relevanceScore: number,
    entityMatches: number,
    eventMatches: number,
  ): number {
    let confidence = relevanceScore * 0.5;
    confidence += Math.min(entityMatches * 0.15, 0.3);
    confidence += Math.min(eventMatches * 0.1, 0.2);
    return Math.min(confidence, 1.0);
  }

  private identifyRisks(
    contract: Contract,
    newsInsight: ParsedNewsInsight,
    analysis: string,
  ): string[] {
    const risks: string[] = [];

    if (
      contract.endDate &&
      new Date(contract.endDate) < new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    ) {
      risks.push('Contract expires soon - limited time for resolution');
    }

    if (contract.volume && contract.volume < 10000) {
      risks.push('Low trading volume - potential liquidity issues');
    }

    if (newsInsight.predictions.some((p) => p.confidence < 0.5)) {
      risks.push('Low confidence in news-based predictions');
    }

    if (analysis.includes('risk') || analysis.includes('uncertain')) {
      risks.push('Analysis indicates uncertainty in outcome');
    }

    return risks;
  }

  private identifyOpportunities(
    contract: Contract,
    newsInsight: ParsedNewsInsight,
    _analysis: string,
  ): string[] {
    const opportunities: string[] = [];

    if (contract.yesPrice < 0.3 && newsInsight.sentiment.overall > 0.5) {
      opportunities.push('Contract underpriced relative to positive sentiment');
    }

    if (contract.yesPrice > 0.7 && newsInsight.sentiment.overall < -0.3) {
      opportunities.push('Contract overpriced relative to negative sentiment');
    }

    if (newsInsight.suggestedActions.some((a) => a.urgency === 'high')) {
      opportunities.push('High urgency news event - potential for quick movement');
    }

    // Check for price volatility if we have previous price data in metadata
    const previousPrice = contract.metadata?.previousPrice as number | undefined;
    if (previousPrice && Math.abs(contract.yesPrice - previousPrice) > 0.1) {
      opportunities.push('Recent price volatility - opportunity for momentum trading');
    }

    return opportunities;
  }
}
