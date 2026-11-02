import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { PantaNectarArena } from "../target/types/panta_nectar_arena";
import {
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";
import crypto from "crypto";

describe("panta_nectar_arena End-to-End Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.PantaNectarArena as Program<PantaNectarArena>;

  const admin = Keypair.generate();
  const oracle = Keypair.generate();
  const competitor1 = Keypair.generate();
  const competitor2 = Keypair.generate();

  let prizeMint: PublicKey;
  let adminTokenAccount: PublicKey;
  let comp1TokenAccount: PublicKey;
  let comp2TokenAccount: PublicKey;

  const competitionId = new BN(777);
  let competitionPDA: PublicKey;
  let escrowPDA: PublicKey;
  let comp1ProfilePDA: PublicKey;
  let comp2ProfilePDA: PublicKey;

  const startTimestamp = Math.floor(Date.now() / 1000) - 100;
  const endTimestamp = Math.floor(Date.now() / 1000) + 10; // Ends shortly
  const minTradeSize = new BN(10 * 1e6); // 10 USDC

  before(async () => {
    // Airdrop SOL
    for (const kp of [admin, oracle, competitor1, competitor2]) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        5 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    // Deploy Mock USDC Prize Mint
    prizeMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );

    // Create Associated Token Accounts
    adminTokenAccount = await createAccount(
      provider.connection,
      admin,
      prizeMint,
      admin.publicKey
    );
    comp1TokenAccount = await createAccount(
      provider.connection,
      competitor1,
      prizeMint,
      competitor1.publicKey
    );
    comp2TokenAccount = await createAccount(
      provider.connection,
      competitor2,
      prizeMint,
      competitor2.publicKey
    );

    // Mint 10,000 USDC to admin for funding escrow
    await mintTo(
      provider.connection,
      admin,
      prizeMint,
      adminTokenAccount,
      admin,
      10_000 * 1e6
    );

    // Derive Program PDAs
    [competitionPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("competition"), competitionId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [escrowPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("arena_escrow"), competitionId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [comp1ProfilePDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("competitor"),
        competitionId.toArrayLike(Buffer, "le", 8),
        competitor1.publicKey.toBuffer(),
      ],
      program.programId
    );

    [comp2ProfilePDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("competitor"),
        competitionId.toArrayLike(Buffer, "le", 8),
        competitor2.publicKey.toBuffer(),
      ],
      program.programId
    );
  });

  it("1. Initializes the competition and escrow PDA successfully", async () => {
    await program.methods
      .initializeCompetition(
        competitionId,
        new BN(startTimestamp),
        new BN(endTimestamp),
        oracle.publicKey,
        minTradeSize
      )
      .accounts({
        competition: competitionPDA,
        prizeMint: prizeMint,
        prizeEscrow: escrowPDA,
        authority: admin.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    const state = await program.account.competitionState.fetch(competitionPDA);
    expect(state.competitionId.toNumber()).to.equal(777);
    expect(state.oracleAuthority.toBase58()).to.equal(oracle.publicKey.toBase58());
    expect(state.isFinalized).to.be.false;
  });

  it("2. Funds the prize escrow vault with 5,000 USDC", async () => {
    const depositAmount = new BN(5_000 * 1e6);

    await program.methods
      .fundPrizePool(depositAmount)
      .accounts({
        competition: competitionPDA,
        prizeEscrow: escrowPDA,
        funderTokenAccount: adminTokenAccount,
        funder: admin.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([admin])
      .rpc();

    const escrowBalance = await getAccount(provider.connection, escrowPDA);
    expect(Number(escrowBalance.amount)).to.equal(5_000 * 1e6);
  });

  it("3. Registers competitors into the competition", async () => {
    await program.methods
      .registerCompetitor(competitionId)
      .accounts({
        competition: competitionPDA,
        competitorProfile: comp1ProfilePDA,
        competitor: competitor1.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([competitor1])
      .rpc();

    await program.methods
      .registerCompetitor(competitionId)
      .accounts({
        competition: competitionPDA,
        competitorProfile: comp2ProfilePDA,
        competitor: competitor2.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([competitor2])
      .rpc();

    const profile1 = await program.account.competitorProfile.fetch(comp1ProfilePDA);
    expect(profile1.competitor.toBase58()).to.equal(competitor1.publicKey.toBase58());
    expect(profile1.totalTrades.toNumber()).to.equal(0);
  });

  it("4. Oracle records verified trades and updates dynamic score", async () => {
    const trade1Hash = crypto.randomBytes(32);
    const [receiptPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), trade1Hash],
      program.programId
    );

    const volume = new BN(1_000 * 1e6); // 1,000 USDC
    const pnl = new BN(200 * 1e6); // +200 USDC (+20%)
    const timestamp = Math.floor(Date.now() / 1000);

    await program.methods
      .recordVerifiedTrade(
        Array.from(trade1Hash),
        volume,
        pnl,
        new BN(timestamp)
      )
      .accounts({
        competition: competitionPDA,
        competitorProfile: comp1ProfilePDA,
        tradeReceipt: receiptPDA,
        oracleAuthority: oracle.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([oracle])
      .rpc();

    const profile1 = await program.account.competitorProfile.fetch(comp1ProfilePDA);
    expect(profile1.totalTrades.toNumber()).to.equal(1);
    expect(profile1.totalVolume.toNumber()).to.equal(1_000 * 1e6);
    expect(profile1.realizedPnl.toNumber()).to.equal(200 * 1e6);
    // Score = 1000 * (10000 + 2000) / 10000 = 1200
    expect(profile1.score.toNumber()).to.equal(1200 * 1e6);
  });

  it("5. Replay attack rejection: Identical trade hash fails immediately", async () => {
    const duplicateHash = crypto.randomBytes(32);
    const [receiptPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), duplicateHash],
      program.programId
    );

    const volume = new BN(50 * 1e6);
    const pnl = new BN(0);
    const timestamp = Math.floor(Date.now() / 1000);

    // First commit
    await program.methods
      .recordVerifiedTrade(Array.from(duplicateHash), volume, pnl, new BN(timestamp))
      .accounts({
        competition: competitionPDA,
        competitorProfile: comp2ProfilePDA,
        tradeReceipt: receiptPDA,
        oracleAuthority: oracle.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([oracle])
      .rpc();

    // Replay attempt must revert
    try {
      await program.methods
        .recordVerifiedTrade(Array.from(duplicateHash), volume, pnl, new BN(timestamp))
        .accounts({
          competition: competitionPDA,
          competitorProfile: comp2ProfilePDA,
          tradeReceipt: receiptPDA,
          oracleAuthority: oracle.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([oracle])
        .rpc();
      expect.fail("Replay transaction should have failed");
    } catch (err: any) {
      expect(err.toString()).to.include("already in use");
    }
  });

  it("6. Finalizes competition after epoch boundary and claims rewards", async () => {
    // Wait for endTimestamp expiration
    await new Promise((res) => setTimeout(res, 11000));

    // Admin finalizes winners
    await program.methods
      .finalizeCompetition([competitor1.publicKey, competitor2.publicKey])
      .accounts({
        competition: competitionPDA,
        authority: admin.publicKey,
      })
      .signers([admin])
      .rpc();

    const state = await program.account.competitionState.fetch(competitionPDA);
    expect(state.isFinalized).to.be.true;

    // Competitor 1 claims Rank 1 prize (3,500 USDC)
    const prizeAmount = new BN(3_500 * 1e6);
    await program.methods
      .claimReward(1, prizeAmount)
      .accounts({
        competition: competitionPDA,
        competitorProfile: comp1ProfilePDA,
        prizeEscrow: escrowPDA,
        competitorTokenAccount: comp1TokenAccount,
        competitor: competitor1.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([competitor1])
      .rpc();

    const winnerBalance = await getAccount(provider.connection, comp1TokenAccount);
    expect(Number(winnerBalance.amount)).to.equal(3_500 * 1e6);

    // Double claim rejection
    try {
      await program.methods
        .claimReward(1, prizeAmount)
        .accounts({
          competition: competitionPDA,
          competitorProfile: comp1ProfilePDA,
          prizeEscrow: escrowPDA,
          competitorTokenAccount: comp1TokenAccount,
          competitor: competitor1.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([competitor1])
        .rpc();
      expect.fail("Double claim must fail");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("PrizeAlreadyClaimed");
    }
  });
});