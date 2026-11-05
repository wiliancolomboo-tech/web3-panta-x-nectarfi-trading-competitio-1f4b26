import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PantaNectarClash } from "../target/types/panta_nectar_clash";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";
import keccak256 from "keccak256";
import { MerkleTree } from "merkletreejs";

describe("panta_nectar_clash core tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.PantaNectarClash as Program<PantaNectarClash>;

  const admin = (provider.wallet as any).payer as Keypair;
  const oracle = Keypair.generate();
  const trader1 = Keypair.generate();
  const trader2 = Keypair.generate();

  let rewardMint: PublicKey;
  let adminTokenAccount: PublicKey;
  let trader1TokenAccount: PublicKey;
  let competitionPda: PublicKey;
  let vaultPda: PublicKey;
  let trader1ParticipantPda: PublicKey;

  const competitionId = new anchor.BN(8881);
  const totalReward = new anchor.BN(10_000_000_000); // 10,000 USDC
  const minStakeBond = new anchor.BN(100_000_000);   // 100 USDC

  before(async () => {
    // Airdrop SOL to test actors
    for (const kp of [oracle, trader1, trader2]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }

    // Create reward mint
    rewardMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );

    // Initialize Token Accounts
    adminTokenAccount = await createAccount(provider.connection, admin, rewardMint, admin.publicKey);
    trader1TokenAccount = await createAccount(provider.connection, trader1, rewardMint, trader1.publicKey);

    // Fund admin and trader1
    await mintTo(provider.connection, admin, rewardMint, adminTokenAccount, admin, 100_000_000_000);
    await mintTo(provider.connection, admin, rewardMint, trader1TokenAccount, admin, 1_000_000_000);

    // Derive PDAs
    [competitionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("competition"), competitionId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("reward_vault"), competitionId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [trader1ParticipantPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("participant"), competitionId.toArrayLike(Buffer, "le", 8), trader1.publicKey.toBuffer()],
      program.programId
    );
  });

  it("1. Initializes competition and deposits reward escrow", async () => {
    const currentTs = Math.floor(Date.now() / 1000);
    const startTs = new anchor.BN(currentTs - 60);
    const endTs = new anchor.BN(currentTs + 3600);

    await program.methods
      .initializeCompetition(
        competitionId,
        startTs,
        endTs,
        minStakeBond,
        totalReward
      )
      .accounts({
        admin: admin.publicKey,
        oracleAuthority: oracle.publicKey,
        rewardMint: rewardMint,
        competition: competitionPda,
        vault: vaultPda,
        adminTokenAccount: adminTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const compAccount = await program.account.competition.fetch(competitionPda);
    expect(compAccount.competitionId.toNumber()).to.equal(competitionId.toNumber());
    expect(compAccount.totalRewardAmount.toNumber()).to.equal(totalReward.toNumber());

    const vaultBalance = await getAccount(provider.connection, vaultPda);
    expect(Number(vaultBalance.amount)).to.equal(totalReward.toNumber());
  });

  it("2. Registers participant with stake bond lock", async () => {
    await program.methods
      .registerParticipant(competitionId)
      .accounts({
        trader: trader1.publicKey,
        competition: competitionPda,
        participant: trader1ParticipantPda,
        rewardMint: rewardMint,
        vault: vaultPda,
        traderTokenAccount: trader1TokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([trader1])
      .rpc();

    const participantAccount = await program.account.participant.fetch(trader1ParticipantPda);
    expect(participantAccount.trader.toBase58()).to.equal(trader1.publicKey.toBase58());
    expect(participantAccount.stakeBond.toNumber()).to.equal(minStakeBond.toNumber());
  });

  it("3. Oracle updates participant metrics & handles wash trading detection", async () => {
    // Legitimate trade update
    await program.methods
      .updateMetrics(
        competitionId,
        new anchor.BN(50_000_000), // 50 USDC volume
        new anchor.BN(12_000_000), // +12 USDC PnL
        new anchor.BN(100),        // 100 NectarFi LP points
        false                      // Not a wash trade
      )
      .accounts({
        oracleAuthority: oracle.publicKey,
        competition: competitionPda,
        participant: trader1ParticipantPda,
      })
      .signers([oracle])
      .rpc();

    let participant = await program.account.participant.fetch(trader1ParticipantPda);
    expect(participant.qualifyingVolume.toNumber()).to.equal(50_000_000);
    expect(participant.realizedPnl.toNumber()).to.equal(12_000_000);
    expect(participant.rejectedWashVolume.toNumber()).to.equal(0);

    // Wash trade update
    await program.methods
      .updateMetrics(
        competitionId,
        new anchor.BN(200_000_000),
        new anchor.BN(0),
        new anchor.BN(0),
        true // Wash trade flagged
      )
      .accounts({
        oracleAuthority: oracle.publicKey,
        competition: competitionPda,
        participant: trader1ParticipantPda,
      })
      .signers([oracle])
      .rpc();

    participant = await program.account.participant.fetch(trader1ParticipantPda);
    expect(participant.qualifyingVolume.toNumber()).to.equal(50_000_000);
    expect(participant.rejectedWashVolume.toNumber()).to.equal(200_000_000);
  });

  it("4. Finalizes competition and verifies Merkle reward claim", async () => {
    // Advance time or setup fast finalization by ending timestamps in test runner
    // Construct Merkle Tree for Claim
    const rewardAmount = new anchor.BN(5_000_000_000); // 50% of pool
    const amountBuf = Buffer.alloc(8);
    amountBuf.writeBigUInt64LE(BigInt(rewardAmount.toString()), 0);

    const leaf = keccak256(Buffer.concat([trader1.publicKey.toBuffer(), amountBuf]));
    const tree = new MerkleTree([leaf], keccak256, { sortPairs: true });
    const rootArray = Array.from(tree.getRoot());

    // Finalize competition
    await program.methods
      .finalizeCompetition(competitionId, rootArray)
      .accounts({
        admin: admin.publicKey,
        competition: competitionPda,
      })
      .rpc();

    const proof = tree.getProof(leaf).map((p) => Array.from(p.data));

    const initialTraderBalance = (await getAccount(provider.connection, trader1TokenAccount)).amount;

    await program.methods
      .claimReward(competitionId, rewardAmount, proof)
      .accounts({
        trader: trader1.publicKey,
        competition: competitionPda,
        participant: trader1ParticipantPda,
        vault: vaultPda,
        traderTokenAccount: trader1TokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([trader1])
      .rpc();

    const finalTraderBalance = (await getAccount(provider.connection, trader1TokenAccount)).amount;
    // Expected disbursement: rewardAmount + returned stakeBond
    const expectedDiff = BigInt(rewardAmount.toString()) + BigInt(minStakeBond.toString());
    expect(finalTraderBalance - initialTraderBalance).to.equal(expectedDiff);
  });
});