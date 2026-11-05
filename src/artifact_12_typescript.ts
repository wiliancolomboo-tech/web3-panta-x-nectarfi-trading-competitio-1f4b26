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
import { assert, expect } from "chai";
import { MerkleTreeEngine, WinnerLeaf } from "../client/src/merkle";

describe("panta_nectar_competition end-to-end suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.PantaNectarCompetition as Program<PantaNectarCompetition>;

  const admin = anchor.web3.Keypair.generate();
  const oracle = anchor.web3.Keypair.generate();
  const trader1 = anchor.web3.Keypair.generate();
  const trader2 = anchor.web3.Keypair.generate();
  const attacker = anchor.web3.Keypair.generate();

  let rewardMint: anchor.web3.PublicKey;
  let adminTokenAccount: anchor.web3.PublicKey;
  let trader1TokenAccount: anchor.web3.PublicKey;
  let trader2TokenAccount: anchor.web3.PublicKey;
  let attackerTokenAccount: anchor.web3.PublicKey;

  let compPda: anchor.web3.PublicKey;
  let vaultPda: anchor.web3.PublicKey;
  let compBump: number;
  let vaultBump: number;

  const compId = new anchor.BN(901);
  const entryFee = new anchor.BN(1_000_000); // 1 Token
  const rewardPool = new anchor.BN(50_000_000); // 50 Tokens

  before(async () => {
    // Airdrop SOL to test actors
    for (const kp of [admin, oracle, trader1, trader2, attacker]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }

    // Initialize Mint
    rewardMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );

    // Create Token Accounts
    adminTokenAccount = await createAccount(provider.connection, admin, rewardMint, admin.publicKey);
    trader1TokenAccount = await createAccount(provider.connection, trader1, rewardMint, trader1.publicKey);
    trader2TokenAccount = await createAccount(provider.connection, trader2, rewardMint, trader2.publicKey);
    attackerTokenAccount = await createAccount(provider.connection, attacker, rewardMint, attacker.publicKey);

    // Mint liquidity
    await mintTo(provider.connection, admin, rewardMint, adminTokenAccount, admin, 1_000_000_000);
    await mintTo(provider.connection, admin, rewardMint, trader1TokenAccount, admin, 10_000_000);
    await mintTo(provider.connection, admin, rewardMint, trader2TokenAccount, admin, 10_000_000);

    // Compute PDA addresses
    [compPda, compBump] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("competition"), compId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [vaultPda, vaultBump] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), compPda.toBuffer()],
      program.programId
    );
  });

  it("1. Initializes competition state and escrow vault successfully", async () => {
    const now = Math.floor(Date.now() / 1000);
    const startTs = new anchor.BN(now - 100);
    const endTs = new anchor.BN(now + 3); // short duration for test lifecycle

    await program.methods
      .initializeCompetition(compId, startTs, endTs, entryFee)
      .accounts({
        competition: compPda,
        vault: vaultPda,
        rewardMint: rewardMint,
        oracle: oracle.publicKey,
        admin: admin.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    const compAccount = await program.account.competition.fetch(compPda);
    assert.isTrue(compAccount.admin.equals(admin.publicKey));
    assert.isTrue(compAccount.oracle.equals(oracle.publicKey));
    assert.equal(compAccount.totalParticipants.toNumber(), 0);
    assert.isFalse(compAccount.isSettled);
  });

  it("2. Funds reward pool into escrow vault", async () => {
    await program.methods
      .fundRewards(rewardPool)
      .accounts({
        competition: compPda,
        vault: vaultPda,
        funderTokenAccount: adminTokenAccount,
        funder: admin.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([admin])
      .rpc();

    const vaultAccount = await getAccount(provider.connection, vaultPda);
    assert.equal(vaultAccount.amount.toString(), rewardPool.toString());
  });

  it("3. Registers Trader 1 and transfers entry fee", async () => {
    const [entryPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("participant"), compPda.toBuffer(), trader1.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .registerParticipant()
      .accounts({
        competition: compPda,
        participantEntry: entryPda,
        vault: vaultPda,
        participantTokenAccount: trader1TokenAccount,
        participant: trader1.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([trader1])
      .rpc();

    const participantAccount = await program.account.participantEntry.fetch(entryPda);
    assert.isTrue(participantAccount.participant.equals(trader1.publicKey));
    assert.isFalse(participantAccount.hasClaimed);
  });

  it("4. Registers Trader 2 and updates participant counter", async () => {
    const [entryPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("participant"), compPda.toBuffer(), trader2.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .registerParticipant()
      .accounts({
        competition: compPda,
        participantEntry: entryPda,
        vault: vaultPda,
        participantTokenAccount: trader2TokenAccount,
        participant: trader2.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([trader2])
      .rpc();

    const compAccount = await program.account.competition.fetch(compPda);
    assert.equal(compAccount.totalParticipants.toNumber(), 2);
  });

  it("5. Settles competition via Oracle with Keccak256 Merkle root", async () => {
    // Wait until competition end time passes
    await new Promise((resolve) => setTimeout(resolve, 4000));

    const winners: WinnerLeaf[] = [
      { participant: trader1.publicKey, rank: 1, amount: new anchor.BN(30_000_000) },
      { participant: trader2.publicKey, rank: 2, amount: new anchor.BN(20_000_000) },
    ];

    const engine = new MerkleTreeEngine(winners);
    const root = engine.getRoot();

    await program.methods
      .settleCompetition(Array.from(root) as any, new anchor.BN(45000))
      .accounts({
        competition: compPda,
        oracle: oracle.publicKey,
      })
      .signers([oracle])
      .rpc();

    const compAccount = await program.account.competition.fetch(compPda);
    assert.isTrue(compAccount.isSettled);
    assert.deepEqual(Buffer.from(compAccount.merkleRoot), root);
  });

  it("6. Allows Rank 1 winner to claim atomic rewards using Merkle proof", async () => {
    const winners: WinnerLeaf[] = [
      { participant: trader1.publicKey, rank: 1, amount: new anchor.BN(30_000_000) },
      { participant: trader2.publicKey, rank: 2, amount: new anchor.BN(20_000_000) },
    ];
    const engine = new MerkleTreeEngine(winners);
    const proof = engine.getProof(winners[0]);

    const [entryPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("participant"), compPda.toBuffer(), trader1.publicKey.toBuffer()],
      program.programId
    );

    const initialBal = (await getAccount(provider.connection, trader1TokenAccount)).amount;

    await program.methods
      .claimReward(1, new anchor.BN(30_000_000), proof.map((p) => Array.from(p) as any))
      .accounts({
        competition: compPda,
        vault: vaultPda,
        participantEntry: entryPda,
        destination: trader1TokenAccount,
        participant: trader1.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([trader1])
      .rpc();

    const finalBal = (await getAccount(provider.connection, trader1TokenAccount)).amount;
    assert.equal(finalBal - initialBal, 30_000_000n);

    const entryAccount = await program.account.participantEntry.fetch(entryPda);
    assert.isTrue(entryAccount.hasClaimed);
  });

  it("7. Defends against double-spend / replay claim attempts", async () => {
    const winners: WinnerLeaf[] = [
      { participant: trader1.publicKey, rank: 1, amount: new anchor.BN(30_000_000) },
      { participant: trader2.publicKey, rank: 2, amount: new anchor.BN(20_000_000) },
    ];
    const engine = new MerkleTreeEngine(winners);
    const proof = engine.getProof(winners[0]);

    const [entryPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("participant"), compPda.toBuffer(), trader1.publicKey.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .claimReward(1, new anchor.BN(30_000_000), proof.map((p) => Array.from(p) as any))
        .accounts({
          competition: compPda,
          vault: vaultPda,
          participantEntry: entryPda,
          destination: trader1TokenAccount,
          participant: trader1.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([trader1])
        .rpc();
      assert.fail("Should have thrown AlreadyClaimed");
    } catch (err: any) {
      expect(err.toString()).to.include("AlreadyClaimed");
    }
  });

  it("8. Rejects forged proof and malicious rank manipulation", async () => {
    const winners: WinnerLeaf[] = [
      { participant: trader1.publicKey, rank: 1, amount: new anchor.BN(30_000_000) },
      { participant: trader2.publicKey, rank: 2, amount: new anchor.BN(20_000_000) },
    ];
    const engine = new MerkleTreeEngine(winners);
    const proof = engine.getProof(winners[1]); // trader2 proof

    // Attacker tries to pass trader2's proof to claim with their own account
    const [entryPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("participant"), compPda.toBuffer(), attacker.publicKey.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .claimReward(2, new anchor.BN(20_000_000), proof.map((p) => Array.from(p) as any))
        .accounts({
          competition: compPda,
          vault: vaultPda,
          participantEntry: entryPda,
          destination: attackerTokenAccount,
          participant: attacker.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([attacker])
        .rpc();
      assert.fail("Should have failed invalid Merkle proof");
    } catch (err: any) {
      expect(err.toString()).to.satisfy(
        (val: string) => val.includes("AccountNotInitialized") || val.includes("InvalidProof")
      );
    }
  });
});