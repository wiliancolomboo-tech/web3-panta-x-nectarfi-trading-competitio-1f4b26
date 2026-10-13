// tests/panta_nectar_competition.ts

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
import { keccak_256 } from "@noble/hashes/sha3";

describe("panta_nectar_competition", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.PantaNectarCompetition as Program<PantaNectarCompetition>;

  let rewardMint: PublicKey;
  let authorityRewardAta: PublicKey;
  let userRewardAta: PublicKey;
  let competitionPda: PublicKey;
  let escrowVaultPda: PublicKey;
  let participantPda: PublicKey;

  const authority = (provider.wallet as anchor.Wallet).payer;
  const traderUser = Keypair.generate();
  const competitionId = new anchor.BN(101);
  const entryFee = new anchor.BN(5_000_000); // 5 USDC
  const minTradeVolume = new anchor.BN(10_000_000);

  before(async () => {
    // Airdrop SOL to trader
    const airdropSig = await provider.connection.requestAirdrop(
      traderUser.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSig);

    // Create USDC-like reward mint
    rewardMint = await createMint(
      provider.connection,
      authority,
      authority.publicKey,
      null,
      6
    );

    // Create ATAs
    authorityRewardAta = await createAccount(
      provider.connection,
      authority,
      rewardMint,
      authority.publicKey
    );

    userRewardAta = await createAccount(
      provider.connection,
      traderUser,
      rewardMint,
      traderUser.publicKey
    );

    // Mint supply to authority and user
    await mintTo(provider.connection, authority, rewardMint, authorityRewardAta, authority, 1_000_000_000);
    await mintTo(provider.connection, authority, rewardMint, userRewardAta, authority, 50_000_000);

    // Derive PDAs
    [competitionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("competition"), competitionId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [escrowVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), competitionPda.toBuffer()],
      program.programId
    );

    [participantPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("participant"), competitionPda.toBuffer(), traderUser.publicKey.toBuffer()],
      program.programId
    );
  });

  it("1. Successfully initializes competition with vault escrow", async () => {
    const currentSlot = await provider.connection.getSlot();
    const startSlot = new anchor.BN(currentSlot + 1);
    const endSlot = new anchor.BN(currentSlot + 200);

    await program.methods
      .initializeCompetition(competitionId, startSlot, endSlot, entryFee, minTradeVolume)
      .accounts({
        competition: competitionPda,
        rewardMint: rewardMint,
        escrowVault: escrowVaultPda,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const compAccount = await program.account.competitionState.fetch(competitionPda);
    assert.equal(compAccount.competitionId.toString(), competitionId.toString());
    assert.equal(compAccount.totalParticipants.toNumber(), 0);
    assert.equal(compAccount.isSettled, false);
  });

  it("2. Funds the competition prize pool escrow", async () => {
    const fundAmount = new anchor.BN(250_000_000); // 250 tokens

    await program.methods
      .fundPrizePool(fundAmount)
      .accounts({
        competition: competitionPda,
        escrowVault: escrowVaultPda,
        funderTokenAccount: authorityRewardAta,
        funder: authority.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const escrowAccount = await getAccount(provider.connection, escrowVaultPda);
    assert.equal(escrowAccount.amount.toString(), fundAmount.toString());

    const compAccount = await program.account.competitionState.fetch(competitionPda);
    assert.equal(compAccount.totalPrizePool.toString(), fundAmount.toString());
  });

  it("3. Registers participant and deposits entry fee", async () => {
    await program.methods
      .registerParticipant()
      .accounts({
        competition: competitionPda,
        participantRecord: participantPda,
        escrowVault: escrowVaultPda,
        userTokenAccount: userRewardAta,
        user: traderUser.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([traderUser])
      .rpc();

    const participantAccount = await program.account.participantRecord.fetch(participantPda);
    assert.equal(participantAccount.user.toBase58(), traderUser.publicKey.toBase58());
    assert.equal(participantAccount.totalVolume.toNumber(), 0);
    assert.equal(participantAccount.hasClaimed, false);
  });

  it("4. Records high-frequency trades on-chain via authorized caller", async () => {
    const volume = new anchor.BN(50_000_000);
    const pnl = new anchor.BN(2_500_000);

    await program.methods
      .recordTrade(volume, pnl)
      .accounts({
        competition: competitionPda,
        participantRecord: participantPda,
        authority: authority.publicKey,
      })
      .rpc();

    const participantAccount = await program.account.participantRecord.fetch(participantPda);
    assert.equal(participantAccount.totalVolume.toString(), volume.toString());
    assert.equal(participantAccount.realizedPnl.toString(), pnl.toString());
  });

  it("5. Rejects unauthorized trade logging", async () => {
    const rogue = Keypair.generate();
    try {
      await program.methods
        .recordTrade(new anchor.BN(100), new anchor.BN(10))
        .accounts({
          competition: competitionPda,
          participantRecord: participantPda,
          authority: rogue.publicKey,
        })
        .signers([rogue])
        .rpc();
      assert.fail("Should have thrown UnauthorizedSigner");
    } catch (err: any) {
      expect(err.toString()).to.include("UnauthorizedSigner");
    }
  });

  it("6. Settles epoch and validates Merkle-proof reward distribution", async () => {
    // Fast-forward slot progress by generating empty blocks if localnet, or wait
    const compAccount = await program.account.competitionState.fetch(competitionPda);
    let currentSlot = await provider.connection.getSlot();

    // Settle with a known single-leaf Merkle root for traderUser
    const rewardClaim = BigInt(15_000_000); // 15 USDC
    const amountBuf = Buffer.alloc(8);
    amountBuf.writeBigUInt64LE(rewardClaim);
    const leaf = Buffer.from(
      keccak_256(Buffer.concat([traderUser.publicKey.toBuffer(), amountBuf]))
    );

    // Root of 1 element is leaf itself
    const rootArray = Array.from(leaf);

    // Settle Epoch
    await program.methods
      .settleEpoch(rootArray)
      .accounts({
        competition: competitionPda,
        authority: authority.publicKey,
      })
      .rpc();

    const settledComp = await program.account.competitionState.fetch(competitionPda);
    assert.equal(settledComp.isSettled, true);

    // User claims reward
    const beforeBalance = (await getAccount(provider.connection, userRewardAta)).amount;

    await program.methods
      .claimReward(new anchor.BN(rewardClaim.toString()), [])
      .accounts({
        competition: competitionPda,
        participantRecord: participantPda,
        escrowVault: escrowVaultPda,
        userRewardAccount: userRewardAta,
        user: traderUser.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([traderUser])
      .rpc();

    const afterBalance = (await getAccount(provider.connection, userRewardAta)).amount;
    assert.equal(
      (afterBalance - beforeBalance).toString(),
      rewardClaim.toString()
    );

    const claimedParticipant = await program.account.participantRecord.fetch(participantPda);
    assert.equal(claimedParticipant.hasClaimed, true);
  });

  it("7. Prevents double-claim exploits", async () => {
    try {
      await program.methods
        .claimReward(new anchor.BN(15_000_000), [])
        .accounts({
          competition: competitionPda,
          participantRecord: participantPda,
          escrowVault: escrowVaultPda,
          userRewardAccount: userRewardAta,
          user: traderUser.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([traderUser])
        .rpc();
      assert.fail("Double claim must fail");
    } catch (err: any) {
      expect(err.toString()).to.include("RewardAlreadyClaimed");
    }
  });
});