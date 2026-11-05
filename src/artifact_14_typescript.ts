export interface TradeRecord {
  txSignature: string;
  maker: string;
  taker: string;
  baseAmount: number;
  quoteAmount: number;
  timestamp: number;
}

export class AntiWashEngine {
  /**
   * Filters out self-matches and circular cross-wallet wash trading:
   * 1. Direct self-trade (maker === taker)
   * 2. Rapid circular ping-pong (A -> B -> A within 60 seconds of matching size)
   */
  public static scrubTrades(trades: TradeRecord[]): TradeRecord[] {
    const filtered: TradeRecord[] = [];
    const recentTradesMap = new Map<string, TradeRecord[]>();

    for (const trade of trades) {
      // 1. Direct self-match rejection
      if (trade.maker === trade.taker) {
        console.warn(`[AntiWash] Flagged direct wash trade in tx: ${trade.txSignature}`);
        continue;
      }

      // 2. Ping-pong cycle detection
      const pairKey = `${trade.maker}:${trade.taker}`;
      const reverseKey = `${trade.taker}:${trade.maker}`;
      const potentialCycles = recentTradesMap.get(reverseKey) || [];

      const isPingPong = potentialCycles.some(prevTrade => {
        const timeDiff = Math.abs(trade.timestamp - prevTrade.timestamp);
        const volumeDiffRatio = Math.abs(trade.quoteAmount - prevTrade.quoteAmount) / prevTrade.quoteAmount;
        return timeDiff < 60 && volumeDiffRatio < 0.02; // within 2% size & 60s
      });

      if (isPingPong) {
        console.warn(`[AntiWash] Flagged ping-pong cycle wash trade: ${trade.txSignature}`);
        continue;
      }

      filtered.push(trade);

      if (!recentTradesMap.has(pairKey)) {
        recentTradesMap.set(pairKey, []);
      }
      recentTradesMap.get(pairKey)!.push(trade);
    }

    return filtered;
  }
}