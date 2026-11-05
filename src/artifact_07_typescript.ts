import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PneCompetition } from "../target/types/pne_competition";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount
} from "@solana/spl-token";
import { expect } from "chai";
import { MerkleTree } from "merkletreejs";
import keccak256 from "keccak256";

describe("Panta x NectarFi Competition Protocol Tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.PneCompetition as Program<PneCompetition>;

  const authority = Keypair.generate();
  const oracle = Keypair.generate();
  const traderAlice = Keypair.generate();
  const traderBob = Keypair.generate();

  let rewardMint: PublicKey;
  let authorityTokenAccount: PublicKey;
  let aliceTokenAccount: PublicKey;
  let competitionPda: PublicKey;
  let vaultPda: PublicKey;
  let aliceTraderPda: PublicKey;

  const competitionId = new anchor.BN(999);
  const totalPrize = new anchor.BN(10_000_000_000); // 10,000 units
  const minThreshold = new anchor.BN(1_000_000);
  const nectarMultiplierBps = 12500; // 1.25x

  before(async () => {
    // Airdrop SOL to test accounts
    for (const kp of [authority, oracle, traderAlice, traderBob]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }

    // Create SPL Token reward mint
    rewardMint = await createMint(
      provider.connection,
      authority,
      authority.publicKey,
      null,
      6
    );

    authorityTokenAccount = await createAccount(
      provider.connection,
      authority,
      rewardMint,
      authority.publicKey
    );

    aliceTokenAccount = await createAccount(
      provider.connection,
      traderAlice,
      rewardMint,
      traderAlice.publicKey
    );

    await mintTo(
      provider.connection,
      authority,
      rewardMint,
      authorityTokenAccount,
      authority,
      100_000_000_000
    );

    [competitionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("competition"), competitionId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("prize_vault"), competitionPda.toBuffer()],
      program.programId
    );

    [aliceTraderPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("trader"), competitionPda.toBuffer(), traderAlice.publicKey.toBuffer()],
      program.programId
    );
  });

  it("1. Initializes competition and locks reward vault tokens", async () => {
    const now = Math.floor(Date.now() / 1000);
    const startTime = new anchor.BN(now - 10);
    const endTime = new anchor.BN(now + 1000);

    await program.methods
      .initializeCompetition(
        competitionId,
        startTime,
        endTime,
        minThreshold,
        nectarMultiplierBps,
        totalPrize
      )
      .accounts({
        competition: competitionPda,
        prizeVault: vaultPda,
        rewardMint: rewardMint,
        authorityTokenAccount: authorityTokenAccount,
        oracleSigner: oracle.publicKey,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([authority])
      .rpc();

    const compAccount = await program.account.competition.fetch(competitionPda);
    expect(compAccount.competitionId.toNumber()).to.equal(999);
    expect(compAccount.totalRewardAmount.toString()).to.equal(totalPrize.toString());

    const vaultBalance = await getAccount(provider.connection, vaultPda);
    expect(vaultBalance.amount.toString()).to.equal(totalPrize.toString());
  });

  it("2. Registers trader Alice for the competition", async () => {
    await program.methods
      .registerTrader()
      .accounts({
        competition: competitionPda,
        traderAccount: aliceTraderPda,
        trader: traderAlice.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([traderAlice])
      .rpc();

    const traderState = await program.account.traderAccount.fetch(aliceTraderPda);
    expect(traderState.competitor.toBase58()).to.equal(traderAlice.publicKey.toBase58());
    expect(traderState.cumulativeVolume.toNumber()).to.equal(0);
  });

  it("3. Ingests Panta swap with NectarFi LP booster", async () => {
    const volumeDelta = new anchor.BN(5_000_000);
    const pnlDelta = new anchor.BN(1_000_000);
    const isNectarLp = true;
    const sequenceId = new anchor.BN(101);

    await program.methods
      .updateTraderMetrics(volumeDelta, pnlDelta, isNectarLp, sequenceId)
      .accounts({
        competition: competitionPda,
        traderAccount: aliceTraderPda,
        oracleSigner: oracle.publicKey,
      })
      .signers([oracle])
      .rpc();

    const traderState = await program.account.traderAccount.fetch(aliceTraderPda);
    expect(traderState.cumulativeVolume.toString()).to.equal(volumeDelta.toString());
    expect(traderState.hasNectarBoost).to.be.true;

    // Expected score: (5,000,000 + 1,000,000) * 1.25 = 7,500,000
    expect(traderState.weightedScore.toNumber()).to.equal(7_500_000);
  });

  it("4. Prevents unauthorized oracle from tampering with metrics", async () => {
    const maliciousAttacker = Keypair.generate();
    let failed = false;
    try {
      await program.methods
        .updateTraderMetrics(new anchor.BN(100), new anchor.BN(100), false, new anchor.BN(102))
        .accounts({
          competition: competitionPda,
          traderAccount: aliceTraderPda,
          oracleSigner: maliciousAttacker.publicKey,
        })
        .signers([maliciousAttacker])
        .rpc();
    } catch (_err) {
      failed = true;
    }
    expect(failed).to.be.true;
  });

  it("5. Rejects out-of-order sequence updates (Anti-Replay)", async () => {
    let failed = false;
    try {
      await program.methods
        .updateTraderMetrics(new anchor.BN(100), new anchor.BN(100), false, new anchor.BN(50)) // 50 < 101
        .accounts({
          competition: competitionPda,
          traderAccount: aliceTraderPda,
          oracleSigner: oracle.publicKey,
        })
        .signers([oracle])
        .rpc();
    } catch (err: any) {
      failed = true;
      expect(err.error.errorCode.code).to.equal("StaleSequenceId");
    }
    expect(failed).to.be.true;
  });

  it("6. Finalizes competition and verifies Merkle prize claim", async () => {
    // Construct Merkle tree where Alice gets 5,000,000 tokens
    const aliceRewardAmount = new anchor.BN(5_000_000);
    const amountBuf = Buffer.alloc(8);
    amountBuf.writeBigUInt64LE(BigInt(aliceRewardAmount.toNumber()));

    const leafAlice = Buffer.concat([
      keccak256(Buffer.concat([traderAlice.publicKey.toBuffer(), amountBuf]))
    ]);

    const dummyLeaf = keccak256(Buffer.from("dummy_record"));
    const tree = new MerkleTree([leafAlice, dummyLeaf], keccak256, { sortPairs: true });
    const root = tree.getRoot();

    // Fast-forward epoch timestamp simulation via admin finalize
    // In live runtime, require(clock >= end_time) is asserted.
    // For localnet unit testing, the authority finalizes:
    await program.methods
      .finalizeCompetition(Array.from(root))
      .accounts({
        competition: competitionPda,
        authority: authority.publicKey,
      })
      .signers([authority])
      .rpc();

    const proof = tree.getProof(leafAlice).map(p => Array.from(p.data));

    // Alice claims her verified reward
    await program.methods
      .claimReward(aliceRewardAmount, proof as any)
      .accounts({
        competition: competitionPda,
        prizeVault: vaultPda,
        traderAccount: aliceTraderPda,
        traderTokenAccount: aliceTokenAccount,
        claimant: traderAlice.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([traderAlice])
      .rpc();

    const aliceBalance = await getAccount(provider.connection, aliceTokenAccount);
    expect(aliceBalance.amount.toString()).to.equal(aliceRewardAmount.toString());

    // Double claim must fail
    let doubleClaimFailed = false;
    try {
      await program.methods
        .claimReward(aliceRewardAmount, proof as any)
        .accounts({
          competition: competitionPda,
          prizeVault: vaultPda,
          traderAccount: aliceTraderPda,
          traderTokenAccount: aliceTokenAccount,
          claimant: traderAlice.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([traderAlice])
        .rpc();
    } catch (err: any) {
      doubleClaimFailed = true;
      expect(err.error.errorCode.code).to.equal("RewardAlreadyClaimed");
    }
    expect(doubleClaimFailed).to.be.true;
  });
});