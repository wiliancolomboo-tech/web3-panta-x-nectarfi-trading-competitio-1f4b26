import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import { MerkleTreeEngine, WinnerLeaf } from "../src/merkle";

describe("PNO Competition Settlement Lifecycle", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // Fallback program lookup or workspace
  const program = anchor.workspace.PnoCompetition as Program<any>;

  const authority = (provider.wallet as any).payer as Keypair;
  const competitor1 = Keypair.generate();
  const competitor2 = Keypair.generate();
  const attacker = Keypair.generate();

  const competitionId = new anchor.BN(9901);
  const epochDuration = new anchor.BN(86400); // 24 hours
  let rewardMint: PublicKey;
  let compStatePda: PublicKey;
  let vaultPda: PublicKey;

  before(async () => {
    // Air-drop funds for gas
    for (const kp of [competitor1, competitor2, attacker]) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig, "confirmed");
    }

    // Create Reward Mint (e.g. Mock USDC)
    rewardMint = await createMint(
      provider.connection,
      authority,
      authority.publicKey,
      null,
      6
    );

    // Derive PDAs
    [compStatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("competition"), competitionId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), competitionId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
  });

  it("1. Initializes competition state and dedicated vault PDA", async () => {
    const startTs = new anchor.BN(Math.floor(Date.now() / 1000) - 3600);
    const endTs = new anchor.BN(Math.floor(Date.now() / 1000) + 864000);

    await program.methods
      .initializeCompetition(competitionId, startTs, endTs, epochDuration)
      .accounts({
        competitionState: compStatePda,
        rewardVault: vaultPda,
        rewardMint: rewardMint,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([authority])
      .rpc();

    // Fund Vault with 10,000 USDC
    await mintTo(
      provider.connection,
      authority,
      rewardMint,
      vaultPda,
      authority,
      10_000 * 1_000_000
    );

    const vaultAcc = await getAccount(provider.connection, vaultPda);
    expect(Number(vaultAcc.amount)).to.equal(10_000 * 1_000_000);
  });

  it("2. Finalizes Epoch #1 with calculated Merkle Root", async () => {
    const winners: WinnerLeaf[] = [
      {
        claimant: competitor1.publicKey,
        competitionId: BigInt(competitionId.toString()),
        epochIndex: 1n,
        rank: 1,
        amount: 5_000_000_000n, // 5,000 USDC
      },
      {
        claimant: competitor2.publicKey,
        competitionId: BigInt(competitionId.toString()),
        epochIndex: 1n,
        rank: 2,
        amount: 3_000_000_000n, // 3,000 USDC
      },
    ];

    const tree = new MerkleTreeEngine(winners);
    const root = tree.getRoot();
    const rootArray = Array.from(root);

    await program.methods
      .finalizeEpoch(new anchor.BN(1), rootArray, new anchor.BN(8_000_000_000))
      .accounts({
        competitionState: compStatePda,
        rewardVault: vaultPda,
        authority: authority.publicKey,
      })
      .signers([authority])
      .rpc();

    const state = await program.account.competitionState.fetch(compStatePda);
    expect(state.currentEpoch.toNumber()).to.equal(1);
    expect(Buffer.from(state.activeMerkleRoot).equals(root)).to.be.true;
  });

  it("3. Competitor #1 claims their verified reward", async () => {
    const winners: WinnerLeaf[] = [
      {
        claimant: competitor1.publicKey,
        competitionId: BigInt(competitionId.toString()),
        epochIndex: 1n,
        rank: 1,
        amount: 5_000_000_000n,
      },
      {
        claimant: competitor2.publicKey,
        competitionId: BigInt(competitionId.toString()),
        epochIndex: 1n,
        rank: 2,
        amount: 3_000_000_000n,
      },
    ];
    const tree = new MerkleTreeEngine(winners);
    const proof = tree.getProof(winners[0]).map((b) => Array.from(b));

    const claimantTokenAccount = await createAccount(
      provider.connection,
      competitor1,
      rewardMint,
      competitor1.publicKey
    );

    const [receiptPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("receipt"),
        competitionId.toArrayLike(Buffer, "le", 8),
        competitor1.publicKey.toBuffer(),
      ],
      program.programId
    );

    await program.methods
      .claimReward(
        new anchor.BN(1),
        1,
        new anchor.BN(5_000_000_000),
        proof
      )
      .accounts({
        competitionState: compStatePda,
        rewardVault: vaultPda,
        claimReceipt: receiptPda,
        claimantTokenAccount: claimantTokenAccount,
        claimant: competitor1.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([competitor1])
      .rpc();

    const claimantAcc = await getAccount(provider.connection, claimantTokenAccount);
    expect(Number(claimantAcc.amount)).to.equal(5_000_000_000);
  });

  it("4. Rejects double-claim attempt on identical epoch", async () => {
    const winners: WinnerLeaf[] = [
      {
        claimant: competitor1.publicKey,
        competitionId: BigInt(competitionId.toString()),
        epochIndex: 1n,
        rank: 1,
        amount: 5_000_000_000n,
      },
      {
        claimant: competitor2.publicKey,
        competitionId: BigInt(competitionId.toString()),
        epochIndex: 1n,
        rank: 2,
        amount: 3_000_000_000n,
      },
    ];
    const tree = new MerkleTreeEngine(winners);
    const proof = tree.getProof(winners[0]).map((b) => Array.from(b));

    const [receiptPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("receipt"),
        competitionId.toArrayLike(Buffer, "le", 8),
        competitor1.publicKey.toBuffer(),
      ],
      program.programId
    );

    // Fetch claimant ATA
    const accounts = await provider.connection.getTokenAccountsByOwner(
      competitor1.publicKey,
      { mint: rewardMint }
    );

    try {
      await program.methods
        .claimReward(
          new anchor.BN(1),
          1,
          new anchor.BN(5_000_000_000),
          proof
        )
        .accounts({
          competitionState: compStatePda,
          rewardVault: vaultPda,
          claimReceipt: receiptPda,
          claimantTokenAccount: accounts.value[0].pubkey,
          claimant: competitor1.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([competitor1])
        .rpc();
      expect.fail("Should have thrown error on double claim");
    } catch (err: any) {
      expect(err.toString()).to.include("RewardAlreadyClaimed");
    }
  });

  it("5. Rejects unauthorized or forged Merkle proof", async () => {
    const fakeProof = [Array.from(Buffer.alloc(32, 1))];

    const claimantTokenAccount = await createAccount(
      provider.connection,
      attacker,
      rewardMint,
      attacker.publicKey
    );

    const [receiptPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("receipt"),
        competitionId.toArrayLike(Buffer, "le", 8),
        attacker.publicKey.toBuffer(),
      ],
      program.programId
    );

    try {
      await program.methods
        .claimReward(
          new anchor.BN(1),
          1,
          new anchor.BN(5_000_000_000),
          fakeProof
        )
        .accounts({
          competitionState: compStatePda,
          rewardVault: vaultPda,
          claimReceipt: receiptPda,
          claimantTokenAccount: claimantTokenAccount,
          claimant: attacker.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([attacker])
        .rpc();
      expect.fail("Attacker should not be able to verify forged proof");
    } catch (err: any) {
      expect(err.toString()).to.include("InvalidMerkleProof");
    }
  });
});