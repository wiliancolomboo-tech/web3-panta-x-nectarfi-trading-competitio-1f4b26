import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import { EnterpriseCompetitionWorker, MerkleTree, TraderStats } from "./competition_worker";
import * as dotenv from "dotenv";

dotenv.config();

const program = new Command();

program
  .name("panta-nectar-cli")
  .description("Enterprise CLI for Panta x NectarFi Trading Competition Administration")
  .version("1.0.0");

program
  .command("finalize-epoch")
  .requiredOption("-c, --competition-id <number>", "Competition Epoch ID")
  .requiredOption("-f, --file <path>", "Path to resolved trader metrics JSON")
  .action(async (options) => {
    const worker = new EnterpriseCompetitionWorker(
      process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
      process.env.AUTHORITY_KEYPAIR_PATH || "./authority.json",
      process.env.RESEND_API_KEY || "",
      process.env.DISCORD_WEBHOOK_URL || "",
      process.env.SLACK_WEBHOOK_URL || ""
    );

    const traders: TraderStats[] = require(options.file);
    traders.sort((a, b) => b.pnl - a.pnl);

    const leaves: Buffer[] = [];
    const prizeRecords = traders.map((trader, idx) => {
      const prizeAmount = BigInt(Math.max(1000 - idx * 100, 50)) * BigInt(10 ** 6); // Tiered distribution
      const leaf = worker.generateLeaf(idx, new PublicKey(trader.address), prizeAmount);
      leaves.push(leaf);
      return { index: idx, address: trader.address, amount: prizeAmount, leaf, email: trader.email };
    });

    const merkleTree = new MerkleTree(leaves);
    const root = merkleTree.getRoot();

    console.log(`✅ Calculated Merkle Root: 0x${root.toString("hex")}`);

    // Broadcast Leaderboard updates to social channels
    await worker.broadcastLeaderboardUpdate(traders, Number(options.competitionId));

    // Dispatch Resend Emails
    for (const record of prizeRecords.slice(0, 3)) {
      if (record.email) {
        await worker.notifyWinnerViaResend(
          record.email,
          record.address,
          record.index + 1,
          (Number(record.amount) / 10 ** 6).toString(),
          `https://app.nectarfi.io/competition/${options.competitionId}/claim`
        );
      }
    }
  });

program.parse(process.argv);