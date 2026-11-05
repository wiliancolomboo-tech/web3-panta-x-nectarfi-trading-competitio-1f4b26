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
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import { MerkleTreeEngine } from "../client/src/merkle";

describe("panta-nectar-arena", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.PantaNectarArena as Program<PantaNectarArena>;

  const authority = Keypair.generate();
  const funder = Keypair.generate();
  const trader1 = Keypair.generate();
  const trader2 = Keypair.generate();
  const maliciousActor = Keypair.generate();

  let rewardMint: PublicKey;
  let funderTokenAccount: PublicKey;
  let trader1TokenAccount: PublicKey;
  let trader2TokenAccount: PublicKey;

  const competitionId = new anchor.BN(42);
  let competitionPda: PublicKey;
  let escrowPda: PublicKey;
  let trader1RecordPda: PublicKey;
  let trader2RecordPda: PublicKey;

  before(async () => {
    // Airdrop SOL
    for (const kp of [authority, funder, trader1, trader2, maliciousActor]) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        5 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    // Initialize Mint (USDC simulation)
    rewardMint = await createMint(
      provider.connection,
      funder,
      authority.publicKey,
      null,
      6
    );

    // Create Token Accounts
    funderTokenAccount = await createAccount(
      provider.connection,
      funder,
      rewardMint,
      funder.publicKey
    );

    trader1TokenAccount = await createAccount(
      provider.connection,
      trader1,
      rewardMint,
      trader1.publicKey
    );

    trader2TokenAccount = await createAccount(
      provider.connection,
      trader2,
      rewardMint,
      trader2.publicKey
    );

    // Mint 100,000 USDC to Funder
    await mintTo(
      provider.connection,
      funder,
      rewardMint,
      funderTokenAccount,
      authority,
      100_000_000000
    );

    // Compute PDAs
    const compIdBuffer = competitionId.toArrayLike(Buffer, "le", 8);
    [competitionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("competition"), compIdBuffer],
      program.programId
    );
    [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), compIdBuffer],
      program.programId
    );
    [trader1RecordPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("participant"), compIdBuffer, trader1.publicKey.toBuffer()],
      program.programId
    );
    [trader2RecordPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("participant"), compIdBuffer, trader2.publicKey.toBuffer()],
      program.programId
    );
  });

  it("1. Initializes competition state and escrow PDA with strict constraints", async () => {
    const currentSlot = await provider.connection.getSlot();
    const startSlot = new anchor.BN(currentSlot);
    const endSlot = new anchor.BN(currentSlot + 15);
    const minVolume = new anchor.BN(1000_000000);

    await program.methods
      .initializeCompetition(
        competitionId,
        "Panta Spring Basis Run",
        startSlot,
        endSlot,
        minVolume
      )
      .accountsStrict({
        competition: competitionPda,
        prizeEscrow: escrowPda,
        rewardMint,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([authority])
      .rpc();

    const compAccount = await program.account.competitionState.fetch(competitionPda);
    expect(compAccount.competitionId.toString()).to.equal(competitionId.toString());
    expect(compAccount.authority.toBase58()).to.equal(authority.publicKey.toBase58());
    expect(compAccount.isFinalized).to.be.false;
  });

  it("2. Funds the prize escrow vault with 20,000 USDC", async () => {
    const fundAmount = new anchor.BN(20_000_000000);

    await program.methods
      .fundPrizePool(fundAmount)
      .accountsStrict({
        competition: competitionPda,
        prizeEscrow: escrowPda,
        funderTokenAccount,
        funder: funder.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([funder])
      .rpc();

    const escrowToken = await getAccount(provider.connection, escrowPda);
    expect(Number(escrowToken.amount)).to.equal(20_000_000000);
  });

  it("3. Registers competitors with referral identifiers", async () => {
    const referralCode = Array.from(Buffer.from("NECTAR01"));

    await program.methods
      .registerCompetitor(competitionId, referralCode)
      .accountsStrict({
        competition: competitionPda,
        participantRecord: trader1RecordPda,
        competitor: trader1.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([trader1])
      .rpc();

    const record = await program.account.participantRecord.fetch(trader1RecordPda);
    expect(record.competitor.toBase58()).to.equal(trader1.publicKey.toBase58());
    expect(record.hasClaimed).to.be.false;
  });

  it("4. Blocks premature finalization prior to end_slot expiration", async () => {
    const dummyRoot = Array.from(Buffer.alloc(32, 1));
    try {
      await program.methods
        .finalizeCompetition(dummyRoot)
        .accountsStrict({
          competition: competitionPda,
          authority: authority.publicKey,
        })
        .signers([authority])
        .rpc();
      expect.fail("Finalization should fail while competition is still active");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("CompetitionStillActive");
    }
  });

  it("5. Computes Merkle Tree, waits for slot expiration, and finalizes competition", async () => {
    const trader1Prize = 12_000_000000n;
    const trader2Prize = 8_000_000000n;

    const merkleEngine = new MerkleTreeEngine([
      { competitor: trader1.publicKey, amount: trader1Prize },
      { competitor: trader2.publicKey, amount: trader2Prize },
    ]);
    const root = merkleEngine.getRoot();

    // Sleep/poll until slot passes end_slot
    let compAccount = await program.account.competitionState.fetch(competitionPda);
    while ((await provider.connection.getSlot()) <= compAccount.endSlot.toNumber()) {
      await new Promise((r) => setTimeout(r, 600));
    }

    await program.methods
      .finalizeCompetition(Array.from(root))
      .accountsStrict({
        competition: competitionPda,
        authority: authority.publicKey,
      })
      .signers([authority])
      .rpc();

    compAccount = await program.account.competitionState.fetch(competitionPda);
    expect(compAccount.isFinalized).to.be.true;
    expect(Buffer.from(compAccount.merkleRoot).toString("hex")).to.equal(root.toString("hex"));
  });

  it("6. Allows qualified competitor to verify proof and claim prize", async () => {
    const trader1Prize = 12_000_000000n;
    const trader2Prize = 8_000_000000n;

    const merkleEngine = new MerkleTreeEngine([
      { competitor: trader1.publicKey, amount: trader1Prize },
      { competitor: trader2.publicKey, amount: trader2Prize },
    ]);
    const proof = merkleEngine.getProof(trader1.publicKey, trader1Prize);

    await program.methods
      .claimPrize(competitionId, new anchor.BN(trader1Prize.toString()), proof)
      .accountsStrict({
        competition: competitionPda,
        prizeEscrow: escrowPda,
        participantRecord: trader1RecordPda,
        competitorTokenAccount: trader1TokenAccount,
        competitor: trader1.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([trader1])
      .rpc();

    const trader1Balance = await getAccount(provider.connection, trader1TokenAccount);
    expect(Number(trader1Balance.amount)).to.equal(12_000_000000);

    const record = await program.account.participantRecord.fetch(trader1RecordPda);
    expect(record.hasClaimed).to.be.true;
  });

  it("7. Defends against duplicate claims (Double Spend Prevention)", async () => {
    const trader1Prize = 12_000_000000n;
    const trader2Prize = 8_000_000000n;

    const merkleEngine = new MerkleTreeEngine([
      { competitor: trader1.publicKey, amount: trader1Prize },
      { competitor: trader2.publicKey, amount: trader2Prize },
    ]);
    const proof = merkleEngine.getProof(trader1.publicKey, trader1Prize);

    try {
      await program.methods
        .claimPrize(competitionId, new anchor.BN(trader1Prize.toString()), proof)
        .accountsStrict({
          competition: competitionPda,
          prizeEscrow: escrowPda,
          participantRecord: trader1RecordPda,
          competitorTokenAccount: trader1TokenAccount,
          competitor: trader1.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([trader1])
        .rpc();
      expect.fail("Should prevent re-claiming already paid prize");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("AlreadyClaimed");
    }
  });

  it("8. Rejects forged Merkle proofs or altered reward amounts", async () => {
    const trader1Prize = 12_000_000000n;
    const trader2Prize = 8_000_000000n;

    const merkleEngine = new MerkleTreeEngine([
      { competitor: trader1.publicKey, amount: trader1Prize },
      { competitor: trader2.publicKey, amount: trader2Prize },
    ]);
    const proof = merkleEngine.getProof(trader1.publicKey, trader1Prize);

    // Malicious trader2 tries claiming trader1's amount with trader1's proof
    try {
      await program.methods
        .claimPrize(competitionId, new anchor.BN(trader1Prize.toString()), proof)
        .accountsStrict({
          competition: competitionPda,
          prizeEscrow: escrowPda,
          participantRecord: trader2RecordPda,
          competitorTokenAccount: trader2TokenAccount,
          competitor: trader2.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([trader2])
        .rpc();
      expect.fail("Forged proof claim must be rejected");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("InvalidMerkleProof");
    }
  });
});