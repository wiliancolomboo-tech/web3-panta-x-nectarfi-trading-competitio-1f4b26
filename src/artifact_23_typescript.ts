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
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { assert, expect } from "chai";
import { MerkleTreeEngine, WinnerEntry } from "../worker/src/merkle";

describe("Panta x NectarFi Trading Competition Test Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.PantaNectarCompetition as Program<PantaNectarCompetition>;

  const admin = Keypair.generate();
  const trader1 = Keypair.generate();
  const trader2 = Keypair.generate();
  const attacker = Keypair.generate();

  let rewardMint: PublicKey;
  let competitionPda: PublicKey;
  let rewardVaultPda: PublicKey;
  let competitionId: anchor.BN;

  before(async () => {
    // Fund test wallets
    const airdropSigners = [admin, trader1, trader2, attacker];
    for (const signer of airdropSigners) {
      const sig = await provider.connection.requestAirdrop(signer.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig, "confirmed");
    }

    // Deploy Reward Mint (e.g. USDC with 6 decimals)
    rewardMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );

    competitionId = new anchor.BN(Date.now());

    [competitionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("competition"), competitionId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [rewardVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("reward_vault"), competitionPda.toBuffer()],
      program.programId
    );
  });

  it("1. Initializes Competition and Funds Vault PDA", async () => {
    const now = Math.floor(Date.now() / 1000);
    const startTs = new anchor.BN(now - 60); // Started 1 minute ago
    const endTs = new anchor.BN(now + 3600); // Ends in 1 hour
    const minVolume = new anchor.BN(100);

    await program.methods
      .initializeCompetition(competitionId, startTs, endTs, minVolume)
      .accounts({
        admin: admin.publicKey,
        rewardMint,
        competition: competitionPda,
        rewardVault: rewardVaultPda,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    // Deposit 10,000 reward tokens into rewardVault PDA
    await mintTo(
      provider.connection,
      admin,
      rewardMint,
      rewardVaultPda,
      admin,
      10_000_000_000
    );

    const vaultAcc = await getAccount(provider.connection, rewardVaultPda);
    assert.equal(vaultAcc.amount.toString(), "10000000000");
  });

  it("2. Registers Participants Deterministically", async () => {
    const [p1Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("participant"), competitionPda.toBuffer(), trader1.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .registerParticipant()
      .accounts({
        trader: trader1.publicKey,
        competition: competitionPda,
        participant: p1Pda,
        systemProgram: SystemProgram.programId,
      })
      .signers([trader1])
      .rpc();

    const participantAccount = await program.account.participant.fetch(p1Pda);
    assert.equal(participantAccount.trader.toBase58(), trader1.publicKey.toBase58());
    assert.equal(participantAccount.totalTradesCount.toNumber(), 0);
  });

  it("3. Records Panta Swaps and NectarFi Yield Real-Time", async () => {
    const [p1Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("participant"), competitionPda.toBuffer(), trader1.publicKey.toBuffer()],
      program.programId
    );

    const now = Math.floor(Date.now() / 1000);

    // Record Panta Swap CPI simulation: $5,000 volume, $450 realized PnL
    await program.methods
      .recordPantaTrade(new anchor.BN(5000), new anchor.BN(450), new anchor.BN(now))
      .accounts({
        executionAuthority: admin.publicKey,
        competition: competitionPda,
        participant: p1Pda,
      })
      .signers([admin])
      .rpc();

    // Record NectarFi Yield: $150 accrued yield
    await program.methods
      .recordNectarYield(new anchor.BN(150))
      .accounts({
        executionAuthority: admin.publicKey,
        competition: competitionPda,
        participant: p1Pda,
      })
      .signers([admin])
      .rpc();

    const state = await program.account.participant.fetch(p1Pda);
    assert.equal(state.totalVolumeUsd.toString(), "5000");
    assert.equal(state.totalPnlUsd.toString(), "600"); // 450 + 150
    assert.equal(state.nectarYieldEarned.toString(), "150");
  });

  it("4. Prevents Stale Execution Timestamp Attack", async () => {
    const [p1Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("participant"), competitionPda.toBuffer(), trader1.publicKey.toBuffer()],
      program.programId
    );

    const staleTimestamp = new anchor.BN(Math.floor(Date.now() / 1000) - 600); // 10 minutes stale

    try {
      await program.methods
        .recordPantaTrade(new anchor.BN(1000), new anchor.BN(100), staleTimestamp)
        .accounts({
          executionAuthority: admin.publicKey,
          competition: competitionPda,
          participant: p1Pda,
        })
        .signers([admin])
        .rpc();
      assert.fail("Should have failed with StaleExecutionTimestamp");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("StaleExecutionTimestamp");
    }
  });

  it("5. Finalizes Competition and Verifies Cryptographic Merkle Prize Claim", async () => {
    // Spin up an ended competition to test finalization
    const endedId = new anchor.BN(Date.now() + 9999);
    const [endedCompPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("competition"), endedId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [endedVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("reward_vault"), endedCompPda.toBuffer()],
      program.programId
    );

    const pastStart = new anchor.BN(Math.floor(Date.now() / 1000) - 200);
    const pastEnd = new anchor.BN(Math.floor(Date.now() / 1000) - 10);

    await program.methods
      .initializeCompetition(endedId, pastStart, pastEnd, new anchor.BN(50))
      .accounts({
        admin: admin.publicKey,
        rewardMint,
        competition: endedCompPda,
        rewardVault: endedVaultPda,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    // Register Trader1 on endedComp
    const [p1EndedPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("participant"), endedCompPda.toBuffer(), trader1.publicKey.toBuffer()],
      program.programId
    );
    await program.methods
      .registerParticipant()
      .accounts({
        trader: trader1.publicKey,
        competition: endedCompPda,
        participant: p1EndedPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([trader1])
      .rpc();

    // Fund Vault
    await mintTo(provider.connection, admin, rewardMint, endedVaultPda, admin, 5_000_000_000);

    // Build Merkle Root
    const winners: WinnerEntry[] = [
      {
        trader: trader1.publicKey,
        rank: 1,
        prizeAmount: 5_000_000_000n,
      },
    ];
    const merkleEngine = new MerkleTreeEngine(winners);
    const rootArray = Array.from(merkleEngine.getRoot());

    // Finalize
    await program.methods
      .finalizeAndSetRoot(rootArray)
      .accounts({
        admin: admin.publicKey,
        competition: endedCompPda,
      })
      .signers([admin])
      .rpc();

    // Trader1 Claims Prize
    const trader1Ata = await createAccount(
      provider.connection,
      trader1,
      rewardMint,
      trader1.publicKey
    );

    const proof = merkleEngine.getProof(0).map((p) => Array.from(p));

    await program.methods
      .claimPrize(1, new anchor.BN(5_000_000_000), proof)
      .accounts({
        claimant: trader1.publicKey,
        competition: endedCompPda,
        participant: p1EndedPda,
        rewardVault: endedVaultPda,
        claimantTokenAccount: trader1Ata,
        rewardMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([trader1])
      .rpc();

    const traderBalance = await getAccount(provider.connection, trader1Ata);
    assert.equal(traderBalance.amount.toString(), "5000000000");

    // Assert double claim rejection
    try {
      await program.methods
        .claimPrize(1, new anchor.BN(5_000_000_000), proof)
        .accounts({
          claimant: trader1.publicKey,
          competition: endedCompPda,
          participant: p1EndedPda,
          rewardVault: endedVaultPda,
          claimantTokenAccount: trader1Ata,
          rewardMint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([trader1])
        .rpc();
      assert.fail("Double claim must fail");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("AlreadyClaimed");
    }
  });
});