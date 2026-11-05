import axios from 'axios';
import { Resend } from 'resend';

export class OmnichannelNotifier {
  private resend?: Resend;
  private discordWebhookUrl?: string;
  private slackWebhookUrl?: string;

  constructor() {
    if (process.env.RESEND_API_KEY) {
      this.resend = new Resend(process.env.RESEND_API_KEY);
    }
    this.discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
    this.slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;
  }

  public async broadcastLeaderboardUpdate(topTraders: Array<{ address: string; score: number; rank: number }>): Promise<void> {
    const fields = topTraders.slice(0, 5).map((t) => ({
      name: `Rank #${t.rank}`,
      value: `\`${t.address.slice(0, 4)}...${t.address.slice(-4)}\` - Score: **${t.score.toLocaleString()}**`,
      inline: false,
    }));

    if (this.discordWebhookUrl) {
      await axios.post(this.discordWebhookUrl, {
        embeds: [{
          title: "🏆 Panta x NectarFi Trading Arena: Top Leaderboard",
          color: 0x00FFA3,
          fields,
          timestamp: new Date().toISOString(),
          footer: { text: "Verified Solana On-Chain Scoring" },
        }],
      }).catch(err => console.error("Discord error:", err.message));
    }

    if (this.slackWebhookUrl) {
      const text = topTraders.slice(0, 5).map(t => `#${t.rank}: ${t.address} | Score: ${t.score}`).join('\n');
      await axios.post(this.slackWebhookUrl, {
        text: `*Panta x NectarFi Leaderboard Snapshot:*\n\`\`\`${text}\`\`\``,
      }).catch(err => console.error("Slack error:", err.message));
    }
  }

  public async sendWinnerNotification(email: string, address: string, prizeUSDC: number, txHash: string): Promise<void> {
    if (!this.resend) {
      console.warn("Resend client not configured; skipping email dispatch.");
      return;
    }

    try {
      await this.resend.emails.send({
        from: 'competitions@nectarfi.exchange',
        to: email,
        subject: '🎉 Congratulations! Claim your Panta x NectarFi Reward',
        html: `
          <div style="font-family: Arial, sans-serif; padding: 20px; background-color: #0b0e14; color: #fff; border-radius: 8px;">
            <h2 style="color: #00FFA3;">Panta x NectarFi Trading Competition Victory</h2>
            <p>Wallet Address: <code>${address}</code></p>
            <p>You have qualified for an official competition prize of <strong>${prizeUSDC.toLocaleString()} USDC</strong>.</p>
            <p>On-chain settlement transaction: <code>${txHash}</code></p>
            <a href="https://trade.panta.fi/competition/claim" style="display:inline-block; padding:12px 24px; background:#00FFA3; color:#000; text-decoration:none; font-weight:bold; border-radius:4px; margin-top: 15px;">Claim Prize in App</a>
          </div>
        `,
      });
      console.log(`Dispatched prize notification to ${email}`);
    } catch (e: any) {
      console.error("Resend API failed:", e.message);
    }
  }
}