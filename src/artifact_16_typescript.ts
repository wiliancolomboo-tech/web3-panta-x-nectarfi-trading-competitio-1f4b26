export interface TradeFillEvent {
  slot: number;
  timestamp: number;
  trader: string;
  counterparty: string;
  market: string;
  sizeUsd: number;
  isMaker: boolean;
}

export class AntiWashValidator {
  private recentFills: Map<string, TradeFillEvent[]> = new Map();

  public evaluateTrade(fill: TradeFillEvent): { isValid: boolean; reason?: string } {
    // 1. Direct Self-Trade Check
    if (fill.trader === fill.counterparty) {
      return { isValid: false, reason: "Self-matched trade detected" };
    }

    // 2. High-frequency reversal wash check (same market, opposite side within 2 slots)
    const traderHistory = this.recentFills.get(fill.trader) || [];
    const circularTrade = traderHistory.find(
      (prev) =>
        prev.market === fill.market &&
        Math.abs(prev.slot - fill.slot) <= 2 &&
        prev.isMaker !== fill.isMaker
    );

    if (circularTrade) {
      return { isValid: false, reason: "Sub-slot cyclic wash fill identified" };
    }

    traderHistory.push(fill);
    if (traderHistory.length > 50) traderHistory.shift();
    this.recentFills.set(fill.trader, traderHistory);

    return { isValid: true };
  }
}