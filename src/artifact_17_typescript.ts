import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PantaNectarCompetition } from "../target/types/panta_nectar_competition";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";
import { keccak_256 } from "js-sha3";

describe("panta-nectar-competition integration tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.PantaNectarCompetition as Program<PantaNectarCompetition>;

  let rewardMint: anchor.web3.PublicKey;
  let authorityRewardAta: anchor.web3.PublicKey;
  let trader1RewardAta: anchor.web3.PublicKey;
  let trader2RewardAta: anchor.web3.PublicKey;

  const authority = provider.wallet as anchor.Wallet;
  const trader1 = anchor.web3.Keypair.generate();
  const trader2 = anchor.web3.Keypair.generate();

  const competitionId = new anchor.BN(8881);
  const entryFee = new anchor.BN(50_000_000); // 50 tokens
  const minTradeSize = new anchor.BN(10_000_000); // 10 tokens

  let competitionPda: anchor.web3.PublicKey;
  let competitionBump: number;
  let rewardVaultPda: anchor.web3.PublicKey;
  let trader1RecordPda: anchor.web3.PublicKey;
  let trader2RecordPda: anchor.web3.PublicKey;

  before(async () => {
    // Air-drop SOL to test accounts
    for (const user of [trader1, trader2]) {
      const sig = await provider.connection.requestAirdrop(
        user.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    // Initialize Mint
    rewardMint = await createMint(
      provider.connection,
      authority.payer,
      authority.publicKey,
      null,
      6
    );

    // Create Token Accounts
    authorityRewardAta = await createAccount(
      provider.connection,
      authority.payer,
      rewardMint,
      authority.publicKey
    );

    trader1RewardAta = await createAccount(
      provider.connection,
      authority.payer,
      rewardMint,
      trader1.publicKey
    );

    trader2RewardAta = await createAccount(
      provider.connection,
      authority.payer,
      rewardMint,
      trader2.publicKey
    );

    // Fund authority & traders
    await mintTo(provider.connection, authority.payer, rewardMint, authorityRewardAta, authority.publicKey, 1_000_000_000_000);
    await mintTo(provider.connection, authority.payer, rewardMint, trader1RewardAta, authority.publicKey, 500_000_000);
    await mintTo(provider.connection, authority.payer, rewardMint, trader2RewardAta, authority.publicKey, 500_000_000);

    // Derive PDAs
    [competitionPda, competitionBump] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("competition"), competitionId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [rewardVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("reward_vault"), competitionPda.toBuffer()],
      program.programId
    );

    [trader1RecordPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("trader_record"), competitionPda.toBuffer(), trader1.publicKey.toBuffer()],
      program.programId
    );

    [trader2RecordPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("trader_record"), competitionPda.toBuffer(), trader2.publicKey.toBuffer()],
      program.programId
    );
  });

  it("1. Initializes competition state with correct bounds", async () => {
    const now = Math.floor(Date.now() / 1000);
    const start = new anchor.BN(now + 2);
    const end = new anchor.BN(now + 6);

    await program.methods
      .initializeCompetition(competitionId, start, end, entryFee, minTradeSize)
      .accounts({
        authority: authority.publicKey,
        rewardMint: rewardMint,
        competition: competitionPda,
        rewardVault: rewardVaultPda,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const state = await program.account.competition.fetch(competitionPda);
    expect(state.authority.toBase58()).to.equal(authority.publicKey.toBase58());
    expect(state.competitionId.toNumber()).to.equal(competitionId.toNumber());
    expect(state.totalTraders.toNumber()).to.equal(0);
  });

  it("2. Funds reward vault from protocol balance", async () => {
    const fundAmount = new anchor.BN(100_000_000);

    await program.methods
      .fundRewardVault(fundAmount)
      .accounts({
        funder: authority.publicKey,
        competition: competitionPda,
        rewardVault: rewardVaultPda,
        funderTokenAccount: authorityRewardAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const vaultAccount = await getAccount(provider.connection, rewardVaultPda);
    expect(Number(vaultAccount.amount)).to.equal(fundAmount.toNumber());
  });

  it("3. Registers trader and transfers entry fee", async () => {
    await program.methods
      .registerTrader()
      .accounts({
        trader: trader1.publicKey,
        competition: competitionPda,
        traderRecord: trader1RecordPda,
        rewardVault: rewardVaultPda,
        traderTokenAccount: trader1RewardAta,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([trader1])
      .rpc();

    const record = await program.account.traderRecord.fetch(trader1RecordPda);
    expect(record.trader.toBase58()).to.equal(trader1.publicKey.toBase58());
    expect(record.cumulativeVolume.toNumber()).to.equal(0);
  });

  it("4. Prevents recording trades below minimum volume threshold", async () => {
    // Wait until start_timestamp
    await new Promise((resolve) => setTimeout(resolve, 3000));

    try {
      await program.methods
        .recordTrade(new anchor.BN(100), new anchor.BN(50))
        .accounts({
          authority: authority.publicKey,
          competition: competitionPda,
          traderRecord: trader1RecordPda,
        })
        .rpc();
      expect.fail("Should have failed on trade size below minimum");
    } catch (e: any) {
      expect(e.toString()).to.include("TradeVolumeBelowMinimum");
    }
  });

  it("5. Records qualified trades and increments aggregate counters", async () => {
    const tradeVolume = new anchor.BN(25_000_000);
    const pnl = new anchor.BN(1_500_000);

    await program.methods
      .recordTrade(tradeVolume, pnl)
      .accounts({
        authority: authority.publicKey,
        competition: competitionPda,
        traderRecord: trader1RecordPda,
      })
      .rpc();

    const record = await program.account.traderRecord.fetch(trader1RecordPda);
    expect(record.cumulativeVolume.toNumber()).to.equal(tradeVolume.toNumber());
    expect(record.cumulativePnl.toNumber()).to.equal(pnl.toNumber());
    expect(record.totalTrades.toNumber()).to.equal(1);
  });

  it("6. Finalizes competition with valid Merkle root after epoch closes", async () => {
    // Wait for end_timestamp
    await new Promise((resolve) => setTimeout(resolve, 4000));

    // Construct simple Merkle tree for Trader 1
    const prizeAmount = new anchor.BN(80_000_000);
    const index = 0;

    const bufIndex = Buffer.alloc(4);
    bufIndex.writeUInt32LE(index, 0);
    const bufAmount = Buffer.alloc(8);
    bufAmount.writeBigUInt64LE(BigInt(prizeAmount.toString()), 0);
    const leaf = Buffer.from(
      keccak_256.arrayBuffer(Buffer.concat([bufIndex, trader1.publicKey.toBuffer(), bufAmount]))
    );

    const root = leaf; // Single leaf tree -> root is the leaf

    const rootArray = Array.from(new Uint8Array(root));

    await program.methods
      .finalizeCompetition(rootArray, new anchor.BN(25_000_000))
      .accounts({
        authority: authority.publicKey,
        competition: competitionPda,
      })
      .rpc();

    const comp = await program.account.competition.fetch(competitionPda);
    expect(comp.isFinalized).to.be.true;
  });

  it("7. Allows trader to claim prize using cryptographic Merkle proof", async () => {
    const prizeAmount = new anchor.BN(80_000_000);
    const index = 0;
    const proof: number[][] = []; // Single leaf, empty proof array

    const balanceBefore = await getAccount(provider.connection, trader1RewardAta);

    await program.methods
      .claimPrize(index, prizeAmount, proof)
      .accounts({
        claimant: trader1.publicKey,
        competition: competitionPda,
        traderRecord: trader1RecordPda,
        rewardVault: rewardVaultPda,
        claimantTokenAccount: trader1RewardAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([trader1])
      .rpc();

    const balanceAfter = await getAccount(provider.connection, trader1RewardAta);
    expect(Number(balanceAfter.amount) - Number(balanceBefore.amount)).to.equal(prizeAmount.toNumber());

    const record = await program.account.traderRecord.fetch(trader1RecordPda);
    expect(record.hasClaimed).to.be.true;
  });

  it("8. Rejects double-claim attacks deterministically", async () => {
    const prizeAmount = new anchor.BN(80_000_000);
    const index = 0;
    const proof: number[][] = [];

    try {
      await program.methods
        .claimPrize(index, prizeAmount, proof)
        .accounts({
          claimant: trader1.publicKey,
          competition: competitionPda,
          traderRecord: trader1RecordPda,
          rewardVault: rewardVaultPda,
          claimantTokenAccount: trader1RewardAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([trader1])
        .rpc();
      expect.fail("Should have thrown error on double claim");
    } catch (e: any) {
      expect(e.toString()).to.include("PrizeAlreadyClaimed");
    }
  });
});