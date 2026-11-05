// File: services/keeper-service.ts

import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import axios from "axios";
import { Resend } from "resend";
import * as dotenv from "dotenv";

dotenv.config();

// Configuration
const RPC_URL = process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899";
const ORACLE_KEYPAIR_PATH = process.env.ORACLE_KEYPAIR_PATH || "./oracle-keypair.json";
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || "PntNctR111111111111111111111111111111111111");
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const resend = new Resend(RESEND_API_KEY);

interface TradeNotification {
    competitionId: string;
    trader: string;
    volume: number;
    pnl: number;
    cumulativeVolume: number;
    cumulativePnl: number;
}

export class ArenaKeeperService {
    private connection: Connection;
    private program: Program;
    private oracleKeypair: Keypair;

    constructor() {
        this.connection = new Connection(RPC_URL, { commitment: "confirmed" });
        
        // Load Oracle Keypair
        if (process.env.ORACLE_SECRET_KEY) {
            const secret = Uint8Array.from(JSON.parse(process.env.ORACLE_SECRET_KEY));
            this.oracleKeypair = Keypair.fromSecretKey(secret);
        } else {
            this.oracleKeypair = Keypair.generate();
        }

        const wallet = new Wallet(this.oracleKeypair);
        const provider = new AnchorProvider(this.connection, wallet, { commitment: "confirmed" });
        anchor.setProvider(provider);

        // Minimal IDL interface definition for standalone client runtime
        const idl = require("../target/idl/panta_nectar_arena.json");
        this.program = new Program(idl, provider);
    }

    /**
     * Broadcast live trade notification to Discord webhook
     */
    public async broadcastTradeEvent(data: TradeNotification): Promise<void> {
        if (!DISCORD_WEBHOOK_URL) return;

        const isProfitable = data.pnl >= 0;
        const color = isProfitable ? 0x00ff88 : 0xff3366;

        const payload = {
            username: "Panta x NectarFi Arena Bot",
            avatar_url: "https://raw.githubusercontent.com/solana/branding/master/icon/solana-badge-dark.png",
            embeds: [
                {
                    title: `⚡ Trade Executed on Arena #${data.competitionId}`,
                    description: `Trader: \`${data.trader.slice(0, 6)}...${data.trader.slice(-4)}\``,
                    color: color,
                    fields: [
                        { name: "Trade Volume", value: `$${(data.volume / 1e6).toFixed(2)}`, inline: true },
                        { name: "PnL Delta", value: `${isProfitable ? "+" : ""}$${(data.pnl / 1e6).toFixed(2)}`, inline: true },
                        { name: "Cumulative Volume", value: `$${(data.cumulativeVolume / 1e6).toFixed(2)}`, inline: true },
                        { name: "Cumulative PnL", value: `$${(data.cumulativePnl / 1e6).toFixed(2)}`, inline: true },
                    ],
                    footer: { text: "Verified via Solana Event Logs" },
                    timestamp: new Date().toISOString(),
                }
            ]
        };

        try {
            await axios.post(DISCORD_WEBHOOK_URL, payload);
        } catch (err: any) {
            console.error("[Keeper] Error posting to Discord:", err.message);
        }
    }

    /**
     * Dispatch email notification to winners using Resend
     */
    public async sendWinnerEmailNotification(
        recipientEmail: string,
        competitionId: string,
        rank: number,
        rewardAmount: number,
        claimTxSignature: string
    ): Promise<void> {
        if (!RESEND_API_KEY) {
            console.log(`[Mock Resend] Alert sent to ${recipientEmail}: Rank #${rank}, Reward: ${rewardAmount}`);
            return;
        }

        try {
            const data = await resend.emails.send({
                from: "Panta x NectarFi Arena <arena@nectar.fi>",
                to: [recipientEmail],
                subject: `🏆 Congratulations! You placed Rank #${rank} in Arena #${competitionId}`,
                html: `
                    <div style="font-family: Arial, sans-serif; background-color: #0b0e14; color: #ffffff; padding: 24px; border-radius: 8px;">
                        <h1 style="color: #14f195;">You're a Winner on Solana!</h1>
                        <p>Your performance in the <strong>Panta x NectarFi Trading Competition</strong> reached the podium.</p>
                        <div style="background-color: #1a1f2c; padding: 16px; border-radius: 6px; margin: 16px 0;">
                            <p style="margin: 4px 0;"><strong>Competition ID:</strong> #${competitionId}</p>
                            <p style="margin: 4px 0;"><strong>Final Rank:</strong> #${rank}</p>
                            <p style="margin: 4px 0;"><strong>Reward Amount:</strong> ${rewardAmount} USDC/MINT</p>
                            <p style="margin: 4px 0;"><strong>Transaction Hash:</strong> <a href="https://solscan.io/tx/${claimTxSignature}" style="color: #9945ff;">${claimTxSignature}</a></p>
                        </div>
                        <p>Your tokens have been transferred directly to your Solana non-custodial wallet.</p>
                    </div>
                `
            });
            console.log(`[Resend] Winner email dispatched successfully. ID: ${data.data?.id}`);
        } catch (error: any) {
            console.error("[Resend] Failed to send winner email:", error.message);
        }
    }

    /**
     * Listen to on-chain WebSocket events and process telemetry
     */
    public listenToEvents(): void {
        console.log(`[Keeper] Listening to program events for: ${PROGRAM_ID.toBase58()}`);

        this.program.addEventListener("TradeRecorded", (event: any, slot: number) => {
            console.log(`[Event: TradeRecorded] Slot ${slot} | Trader: ${event.trader.toBase58()}`);
            this.broadcastTradeEvent({
                competitionId: event.competitionId.toString(),
                trader: event.trader.toBase58(),
                volume: event.volumeDelta.toNumber(),
                pnl: event.pnlDelta.toNumber(),
                cumulativeVolume: event.cumulativeVolume.toNumber(),
                cumulativePnl: event.cumulativePnl.toNumber(),
            });
        });

        this.program.addEventListener("CompetitionSettled", (event: any, slot: number) => {
            console.log(`[Event: CompetitionSettled] Slot ${slot} | Winner 1: ${event.winner1.toBase58()}`);
            if (DISCORD_WEBHOOK_URL) {
                axios.post(DISCORD_WEBHOOK_URL, {
                    content: `🚨 **Competition #${event.competitionId.toString()} Settled!**\n` +
                             `🥇 1st Place: \`${event.winner1.toBase58()}\`\n` +
                             `🥈 2nd Place: \`${event.winner2.toBase58()}\`\n` +
                             `🥉 3rd Place: \`${event.winner3.toBase58()}\`\n` +
                             `Total Prize Escrow: ${(event.prizePool.toNumber() / 1e6).toFixed(2)} USDC`
                }).catch(err => console.error(err.message));
            }
        });
    }
}

// Service Runner
if (require.main === module) {
    const service = new ArenaKeeperService();
    service.listenToEvents();
}