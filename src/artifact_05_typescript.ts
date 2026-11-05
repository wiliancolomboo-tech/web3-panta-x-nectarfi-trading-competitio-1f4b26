import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import { keccak_256 } from "js-sha3";
import { PantaNectarCompetition } from "../target/types/panta_nectar_competition";

describe("panta_nectar_competition", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.PantaNectarCompetition as Program<PantaNectarCompetition>;

  const admin = Keypair.generate();
  const keeper = Keypair.generate();
  const trader1 = Keypair.generate();
  const trader2 = Keypair.generate();
  const sybilTrader = Keypair.generate();

  let rewardMint: PublicKey;
  let adminTokenAccount: PublicKey;
  let trader1TokenAccount: PublicKey;
  let competitionPda: PublicKey;
  let escrowVaultPda: PublicKey;

  const competitionId = new anchor.BN(Date.now());
  const competitionName = "Panta x NectarFi Launch Arena";

  before(async () => {
    // Airdrop SOL to test actors
    for (const actor of [admin, keeper, trader1, trader2, sybilTrader]) {
      const sig = await provider.connection.requestAirdrop(actor.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }

    // Create reward token mint
    rewardMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );

    // Create Admin Token Account and Mint initial pool funds
    const adminAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      rewardMint,
      admin.publicKey
    );
    adminTokenAccount = adminAta.address;

    await mintTo(
      provider.connection,
      admin,
      rewardMint,
      adminTokenAccount,
      admin,
      1_000_000 * 10 ** 6 // 1,000,000 tokens
    );

    // Resolve PDAs
    [competitionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("competition"), competitionId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [escrowVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow_vault"), competitionPda.toBuffer()],
      program.programId
    );

    // Trader1 ATA
    const trader1Ata = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      trader1,
      rewardMint,
      trader1.publicKey
    );
    trader1TokenAccount = trader1Ata.address;
  });

  it("1. Initializes competition successfully", async () => {
    const now = Math.floor(Date.now() / 1000);
    const startTs = new anchor.BN(now - 100);
    const endTs = new anchor.BN(now + 10); // Ends in 10 seconds for testing
    const minVol = new anchor.BN(500 * 10 ** 6);

    await program.methods
      .initializeCompetition(
        competitionId,
        competitionName,
        startTs,
        endTs,
        minVol,
        keeper.publicKey
      )
      .accounts({
        competition: competitionPda,
        rewardMint,
        escrowVault: escrowVaultPda,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    const compAccount = await program.account.competitionState.fetch(competitionPda);
    expect(compAccount.name).to.equal(competitionName);
    expect(compAccount.merkleRootUpdateAuthority.toBase58()).to.equal(keeper.publicKey.toBase58());
    expect(compAccount.isFinalized).to.be.false;
  });

  it("2. Registers participant within valid window", async () => {
    const [participantPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("participant"), competitionPda.toBuffer(), trader1.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .registerParticipant()
      .accounts({
        competition: competitionPda,
        participant: participantPda,
        user: trader1.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([trader1])
      .rpc();

    const participantAccount = await program.account.participantState.fetch(participantPda);
    expect(participantAccount.user.toBase58()).to.equal(trader1.publicKey.toBase58());
    expect(participantAccount.hasClaimed).to.be.false;
  });

  it("3. Funds the prize escrow pool", async () => {
    const fundAmount = new anchor.BN(100_000 * 10 ** 6);

    await program.methods
      .fundPrizePool(fundAmount)
      .accounts({
        competition: competitionPda,
        escrowVault: escrowVaultPda,
        funderTokenAccount: adminTokenAccount,
        funder: admin.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([admin])
      .rpc();

    const compAccount = await program.account.competitionState.fetch(competitionPda);
    expect(compAccount.totalPrizePool.toString()).to.equal(fundAmount.toString());
  });

  it("4. Prevents unauthorized party from finalizing Merkle root", async () => {
    const dummyRoot = Array.from(Buffer.alloc(32, 1));
    try {
      await program.methods
        .finalizeCompetition(dummyRoot)
        .accounts({
          competition: competitionPda,
          keeper: trader1.publicKey, // Invalid signer
        })
        .signers([trader1])
        .rpc();
      expect.fail("Should have thrown unauthorized error");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("UnauthorizedKeeper");
    }
  });

  it("5. Finalizes competition and verifies Merkle root", async () => {
    // Wait for endTs to expire
    await new Promise((resolve) => setTimeout(resolve, 11000));

    // Construct valid Merkle tree with Trader1 as Rank 1 Winner
    const rank = 1;
    const amount = new anchor.BN(100_000 * 10 ** 6);

    const rankBuf = Buffer.alloc(4);
    rankBuf.writeUInt32LE(rank);
    const amountBuf = Buffer.alloc(8);
    amountBuf.writeBigUInt64LE(BigInt(amount.toString()));

    const leafHash = Buffer.from(
      keccak_256.digest(Buffer.concat([trader1.publicKey.toBuffer(), rankBuf, amountBuf]))
    );

    // Root is leafHash when single node
    const rootArray = Array.from(leafHash);

    await program.methods
      .finalizeCompetition(rootArray)
      .accounts({
        competition: competitionPda,
        keeper: keeper.publicKey,
      })
      .signers([keeper])
      .rpc();

    const compAccount = await program.account.competitionState.fetch(competitionPda);
    expect(compAccount.isFinalized).to.be.true;
    expect(Buffer.from(compAccount.finalMerkleRoot).toString("hex")).to.equal(leafHash.toString("hex"));
  });

  it("6. Allows participant to claim prize with valid Merkle proof", async () => {
    const rank = 1;
    const amount = new anchor.BN(100_000 * 10 ** 6);
    const emptyProof: number[][] = []; // Single-leaf tree requires zero sibling proofs

    const [claimRecordPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("claim"), competitionPda.toBuffer(), trader1.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .claimPrize(rank, amount, emptyProof)
      .accounts({
        competition: competitionPda,
        claimRecord: claimRecordPda,
        escrowVault: escrowVaultPda,
        userTokenAccount: trader1TokenAccount,
        user: trader1.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([trader1])
      .rpc();

    const claimAccount = await program.account.claimRecord.fetch(claimRecordPda);
    expect(claimAccount.hasClaimed).to.be.true;
    expect(claimAccount.amount.toString()).to.equal(amount.toString());
  });

  it("7. Strict Reentrancy/Double-Claim Guard rejection", async () => {
    const rank = 1;
    const amount = new anchor.BN(100_000 * 10 ** 6);
    const emptyProof: number[][] = [];

    const [claimRecordPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("claim"), competitionPda.toBuffer(), trader1.publicKey.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .claimPrize(rank, amount, emptyProof)
        .accounts({
          competition: competitionPda,
          claimRecord: claimRecordPda,
          escrowVault: escrowVaultPda,
          userTokenAccount: trader1TokenAccount,
          user: trader1.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([trader1])
        .rpc();
      expect.fail("Should have failed on second claim attempt");
    } catch (err: any) {
      // PDA already initialized or caught by custom check
      expect(err.toString()).to.include("already in use");
    }
  });
});