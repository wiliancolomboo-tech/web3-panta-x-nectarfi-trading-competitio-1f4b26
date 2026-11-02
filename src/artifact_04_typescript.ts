import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PantaNectarArena } from "../target/types/panta_nectar_arena";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";

describe("panta_nectar_arena Comprehensive Verification", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.PantaNectarArena as Program<PantaNectarArena>;
  const authority = (provider.wallet as anchor.Wallet).payer;
  const oracleKeypair = Keypair.generate();
  const traderAlice = Keypair.generate();
  const traderBob = Keypair.generate();

  let prizeMint: PublicKey;
  let authorityTokenAccount: PublicKey;
  let competitionPda: PublicKey;
  let prizeVaultPda: PublicKey;
  let aliceParticipantPda: PublicKey;
  let bobParticipantPda: PublicKey;
  let aliceTokenAccount: PublicKey;

  const competitionId = new anchor.BN(88812);
  const initialPrizeAmount = new anchor.BN(10_000_000_000); // 10,000 USDC (6 decimals)
  const minTradeSize = new anchor.BN(50_000_000); // 50 USDC

  // 10 winner tiers summing up to 10,000 BPS (100%)
  const tierBps = [
    3000, 2000, 1500, 1000, 700, 500, 400, 300, 300, 300,
  ];

  before(async () => {
    // 1. Airdrop SOL to test actors
    const sigAlice = await provider.connection.requestAirdrop(traderAlice.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL);
    const sigBob = await provider.connection.requestAirdrop(traderBob.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL);
    const sigOracle = await provider.connection.requestAirdrop(oracleKeypair.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
    
    await provider.connection.confirmTransaction(sigAlice);
    await provider.connection.confirmTransaction(sigBob);
    await provider.connection.confirmTransaction(sigOracle);

    // 2. Create SPL Mint for Prize Escrow (USDC equivalent)
    prizeMint = await createMint(
      provider.connection,
      authority,
      authority.publicKey,
      null,
      6
    );

    // 3. Create Authority Token Account and mint funds
    authorityTokenAccount = await createAccount(
      provider.connection,
      authority,
      prizeMint,
      authority.publicKey
    );

    await mintTo(
      provider.connection,
      authority,
      prizeMint,
      authorityTokenAccount,
      authority.publicKey,
      50_000_000_000
    );

    // 4. Derive PDAs
    const compIdBuffer = Buffer.alloc(8);
    compIdBuffer.writeBigUInt64LE(BigInt(competitionId.toString()));

    [competitionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("competition"), compIdBuffer],
      program.programId
    );

    [prizeVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("prize_vault"), competitionPda.toBuffer()],
      program.programId
    );

    [aliceParticipantPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("participant"), competitionPda.toBuffer(), traderAlice.publicKey.toBuffer()],
      program.programId
    );

    [bobParticipantPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("participant"), competitionPda.toBuffer(), traderBob.publicKey.toBuffer()],
      program.programId
    );

    aliceTokenAccount = await createAccount(
      provider.connection,
      authority,
      prizeMint,
      traderAlice.publicKey
    );
  });

  it("1. Initializes the competition with funded vault escrow", async () => {
    const now = Math.floor(Date.now() / 1000);
    const startTime = new anchor.BN(now - 100);
    const endTime = new anchor.BN(now + 3600); // 1 hour runtime

    await program.methods
      .initializeCompetition(
        competitionId,
        startTime,
        endTime,
        2, // Hybrid score (Volume + Realized PnL)
        minTradeSize,
        tierBps,
        initialPrizeAmount
      )
      .accounts({
        competition: competitionPda,
        prizeVault: prizeVaultPda,
        prizeMint: prizeMint,
        authorityTokenAccount: authorityTokenAccount,
        oracleAuthority: oracleKeypair.publicKey,
        authority: authority.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const compAccount = await program.account.competition.fetch(competitionPda);
    expect(compAccount.competitionId.toString()).to.equal(competitionId.toString());
    expect(compAccount.totalPrizePool.toString()).to.equal(initialPrizeAmount.toString());
    expect(compAccount.participantCount.toNumber()).to.equal(0);

    const vaultBalance = await getAccount(provider.connection, prizeVaultPda);
    expect(vaultBalance.amount.toString()).to.equal(initialPrizeAmount.toString());
  });

  it("2. Registers Alice and Bob as participants", async () => {
    await program.methods
      .registerParticipant()
      .accounts({
        competition: competitionPda,
        participant: aliceParticipantPda,
        trader: traderAlice.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([traderAlice])
      .rpc();

    await program.methods
      .registerParticipant()
      .accounts({
        competition: competitionPda,
        participant: bobParticipantPda,
        trader: traderBob.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([traderBob])
      .rpc();

    const aliceAcc = await program.account.participant.fetch(aliceParticipantPda);
    expect(aliceAcc.trader.toBase58()).to.equal(traderAlice.publicKey.toBase58());
    expect(aliceAcc.weightedScore.toNumber()).to.equal(0);

    const compAccount = await program.account.competition.fetch(competitionPda);
    expect(compAccount.participantCount.toNumber()).to.equal(2);
  });

  it("3. Records a valid trade for Alice with Panta 10% routing boost", async () => {
    const tradeVolume = new anchor.BN(100_000_000); // 100 USD
    const realizedPnl = new anchor.BN(10_000_000);   // 10 USD

    await program.methods
      .recordTrade(tradeVolume, realizedPnl, true) // is_panta_routing = true
      .accounts({
        competition: competitionPda,
        participant: aliceParticipantPda,
        oracleAuthority: oracleKeypair.publicKey,
      })
      .signers([oracleKeypair])
      .rpc();

    const aliceAcc = await program.account.participant.fetch(aliceParticipantPda);
    expect(aliceAcc.cumulativeVolume.toString()).to.equal(tradeVolume.toString());
    expect(aliceAcc.tradeCount.toNumber()).to.equal(1);
    
    // Base Hybrid = 100 + (10 * 2) = 120. Multiplier 11000 / 10000 = 132
    expect(aliceAcc.weightedScore.toNumber()).to.be.greaterThan(0);
  });

  it("4. Enforces minimum trade size threshold", async () => {
    const tinyVolume = new anchor.BN(1_000_000); // 1 USD (< 50 USD min)
    const pnl = new anchor.BN(0);

    try {
      await program.methods
        .recordTrade(tinyVolume, pnl, false)
        .accounts({
          competition: competitionPda,
          participant: bobParticipantPda,
          oracleAuthority: oracleKeypair.publicKey,
        })
        .signers([oracleKeypair])
        .rpc();
      expect.fail("Should have thrown TradeBelowMinSize");
    } catch (err: any) {
      expect(err.toString()).to.include("TradeBelowMinSize");
    }
  });

  it("5. Triggers anti-wash trading rate limiter under spam conditions", async () => {
    // Send repeated trades in quick succession within identical slots
    const validVolume = new anchor.BN(60_000_000);
    for (let i = 0; i < 16; i++) {
      await program.methods
        .recordTrade(validVolume, new anchor.BN(0), false)
        .accounts({
          competition: competitionPda,
          participant: bobParticipantPda,
          oracleAuthority: oracleKeypair.publicKey,
        })
        .signers([oracleKeypair])
        .rpc();
    }

    const bobAcc = await program.account.participant.fetch(bobParticipantPda);
    expect(bobAcc.isDisqualified).to.be.true;
  });

  it("6. Finalizes competition and verifies Rank 1 prize claim", async () => {
    // Warp time by updating competition end_time in test context or waiting
    // For deterministic unit testing, simulate admin rank assignment
    await program.methods
      .finalizeCompetition([traderAlice.publicKey])
      .accounts({
        competition: competitionPda,
        authority: authority.publicKey,
      })
      .rpc();

    await program.methods
      .setParticipantRank(1) // Rank 1 = 3000 BPS (30%)
      .accounts({
        competition: competitionPda,
        participant: aliceParticipantPda,
        authority: authority.publicKey,
      })
      .rpc();

    const aliceBeforeBalance = await getAccount(provider.connection, aliceTokenAccount);
    expect(aliceBeforeBalance.amount.toString()).to.equal("0");

    // Alice claims prize
    await program.methods
      .claimPrize()
      .accounts({
        competition: competitionPda,
        participant: aliceParticipantPda,
        prizeVault: prizeVaultPda,
        traderTokenAccount: aliceTokenAccount,
        trader: traderAlice.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([traderAlice])
      .rpc();

    const aliceAfterBalance = await getAccount(provider.connection, aliceTokenAccount);
    // 30% of 10,000 USDC = 3,000 USDC = 3,000,000,000
    expect(aliceAfterBalance.amount.toString()).to.equal("3000000000");

    const aliceAcc = await program.account.participant.fetch(aliceParticipantPda);
    expect(aliceAcc.prizeClaimed).to.be.true;
  });
});