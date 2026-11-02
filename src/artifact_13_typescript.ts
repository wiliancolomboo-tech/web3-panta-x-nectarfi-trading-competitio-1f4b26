import axios from "axios";
import { Resend } from "resend";

export interface TelemetryConfig {
  slackWebhookUrl?: string;
  resendApiKey?: string;
  senderEmail?: string;
}

export class EnterpriseNotifier {
  private resend?: Resend;
  private slackWebhookUrl?: string;
  private senderEmail: string;

  constructor(cfg: TelemetryConfig) {
    this.slackWebhookUrl = cfg.slackWebhookUrl;
    if (cfg.resendApiKey) {
      this.resend = new Resend(cfg.resendApiKey);
    }
    this.senderEmail = cfg.senderEmail || "arena@nectarfi.com";
  }

  public async broadcastSlackLeaderboardUpdate(
    competitionId: number,
    leaderboard: Array<{ trader: string; volume: string; pnl: string }>
  ): Promise<void> {
    if (!this.slackWebhookUrl) return;

    const fields = leaderboard.slice(0, 5).map((l, idx) => ({
      type: "mrkdwn",
      text: `*Rank ${idx + 1}:* \`${l.trader.slice(0, 4)}...${l.trader.slice(-4)}\`\n*Vol:* $${l.volume} | *PnL:* ${l.pnl}`,
    }));

    const payload = {
      text: `🏆 *Panta x NectarFi Arena #${competitionId} Leaderboard Update*`,
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: `⚔️ Arena #${competitionId}: Top Standings`,
            emoji: true,
          },
        },
        {
          type: "section",
          fields,
        },
      ],
    };

    try {
      await axios.post(this.slackWebhookUrl, payload, { timeout: 5000 });
    } catch (err: any) {
      console.error("[Notifier:Slack] Error dispatching webhook:", err.message);
    }
  }

  public async sendWinnerNotificationEmail(
    recipientEmail: string,
    traderPubkey: string,
    competitionId: number,
    rank: number,
    prizeAmount: string
  ): Promise<void> {
    if (!this.resend) return;

    try {
      await this.resend.emails.send({
        from: this.senderEmail,
        to: recipientEmail,
        subject: `🎉 Congratulations! You Placed Rank #${rank} in Panta x NectarFi Arena #${competitionId}`,
        html: `
          <div style="font-family: Arial, sans-serif; background: #0f172a; color: #f8fafc; padding: 32px; border-radius: 8px;">
            <h1 style="color: #38bdf8;">You Won in Panta x NectarFi Trading Arena!</h1>
            <p>Wallet Address: <code>${traderPubkey}</code></p>
            <p>Official Standing: <strong>Rank #${rank}</strong></p>
            <p>Your Claimable Prize: <strong>${prizeAmount} SPL Units</strong></p>
            <hr style="border-color: #334155;" />
            <p>Connect your wallet to the official dApp claim portal to withdraw your reward escrow directly.</p>
          </div>
        `,
      });
      console.log(`[Notifier:Resend] Dispatched victory notification to ${recipientEmail}`);
    } catch (err: any) {
      console.error("[Notifier:Resend] Error dispatching email:", err.message);
    }
  }
}