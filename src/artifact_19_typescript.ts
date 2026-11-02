import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PantaNectarCompetition } from "../target/types/panta_nectar_competition";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";
import keccak256 from "keccak256";
import MerkleTree from "merkletreejs";

describe("panta-nectar-competition integration suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.PantaNectarCompetition as Program<PantaNectarCompetition>;

  let host: Keypair;
  let trader1: Keypair;
  let trader2: Keypair;
  let attacker: Keypair;
  let prizeMint: PublicKey;
  let hostTokenAccount: PublicKey;
  let trader1TokenAccount: PublicKey;
  let trader2TokenAccount: PublicKey;

  const compId = Buffer.alloc(32);
  compId.write("PANTA_NECTAR_COMP_2025_SEASON1");

  let compPDA: PublicKey;
  let vaultPDA: PublicKey;

  before(async () => {
    host = Keypair.generate();
    trader1 = Keypair.generate();
    trader2 = Keypair.generate();
    attacker = Keypair.generate();

    // Airdrop SOL to test actors
    for (const actor of [host, trader1, trader2, attacker]) {
      const sig = await provider.connection.requestAirdrop(actor.publicKey, 5 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }

    // Create Prize Mint (USDC Mock)
    prizeMint = await createMint(
      provider.connection,
      host,
      host.publicKey,
      null,
      6
    );

    // Initialize Token Accounts
    hostTokenAccount = await createAccount(provider.connection, host, prizeMint, host.publicKey);
    trader1TokenAccount = await createAccount(provider.connection, trader1, prizeMint, trader1.publicKey);
    trader2TokenAccount = await createAccount(provider.connection, trader2, prizeMint, trader2.publicKey);

    // Mint 20,000 tokens to Host
    await mintTo(provider.connection, host, prizeMint, hostTokenAccount, host, 20_000_000_000);

    [compPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("competition"), compId],
      program.programId
    );

    [vaultPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), compPDA.toBuffer()],
      program.programId
    );
  });

  it("1. Successfully initializes a new competition escrow", async () => {
    const now = Math.floor(Date.now() / 1000);
    const start = new anchor.BN(now - 100);
    const end = new anchor.BN(now + 2);
    const deadline = new anchor.BN(now + 10);

    await program.methods
      .initializeCompetition(Array.from(compId), start, end, deadline)
      .accounts({
        host: host.publicKey,
        prizeMint: prizeMint,
        competition: compPDA,
        vault: vaultPDA,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([host])
      .rpc();

    const compAccount = await program.account.competition.fetch(compPDA);
    expect(compAccount.host.toBase58()).to.equal(host.publicKey.toBase58());
    expect(compAccount.prizeMint.toBase58()).to.equal(prizeMint.toBase58());
    expect(compAccount.totalPrizeAmount.toNumber()).to.equal(0);
  });

  it("2. Deposits prize tokens into non-custodial PDA vault", async () => {
    const depositAmount = new anchor.BN(10_000_000_000);

    await program.methods
      .depositPrize(depositAmount)
      .accounts({
        depositor: host.publicKey,
        competition: compPDA,
        prizeMint: prizeMint,
        vault: vaultPDA,
        depositorTokenAccount: hostTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([host])
      .rpc();

    const vaultBalance = await getAccount(provider.connection, vaultPDA);
    expect(Number(vaultBalance.amount)).to.equal(10_000_000_000);

    const compAccount = await program.account.competition.fetch(compPDA);
    expect(compAccount.totalPrizeAmount.toNumber()).to.equal(10_000_000_000);
  });

  it("3. Publishes verified Merkle root once epoch closes", async () => {
    // Wait until end timestamp expires
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Construct Merkle tree for Trader1 (Rank 1: 6,000) & Trader2 (Rank 2: 4,000)
    const makeLeaf = (wallet: PublicKey, rank: number, amount: bigint) => {
      const rankBuf = Buffer.alloc(4);
      rankBuf.writeUInt32LE(rank, 0);
      const amountBuf = Buffer.alloc(8);
      amountBuf.writeBigUInt64LE(amount, 0);
      return keccak256(Buffer.concat([wallet.toBuffer(), rankBuf, amountBuf]));
    };

    const leaf1 = makeLeaf(trader1.publicKey, 1, BigInt(6_000_000_000));
    const leaf2 = makeLeaf(trader2.publicKey, 2, BigInt(4_000_000_000));

    const tree = new MerkleTree([leaf1, leaf2], keccak256, { sortPairs: true });
    const root = tree.getRoot();

    const ipfsCid = Buffer.alloc(64);
    ipfsCid.write("QmZtmD2qt8SfmCMM444444444444444444444444444444");

    await program.methods
      .publishResults(Array.from(root), Array.from(ipfsCid))
      .accounts({
        host: host.publicKey,
        competition: compPDA,
      })
      .signers([host])
      .rpc();

    const compAccount = await program.account.competition.fetch(compPDA);
    expect(Buffer.from(compAccount.merkleRoot).toString("hex")).to.equal(root.toString("hex"));
  });

  it("4. Allows valid winner to claim prize using cryptographic Merkle proof", async () => {
    const makeLeaf = (wallet: PublicKey, rank: number, amount: bigint) => {
      const rankBuf = Buffer.alloc(4);
      rankBuf.writeUInt32LE(rank, 0);
      const amountBuf = Buffer.alloc(8);
      amountBuf.writeBigUInt64LE(amount, 0);
      return keccak256(Buffer.concat([wallet.toBuffer(), rankBuf, amountBuf]));
    };

    const leaf1 = makeLeaf(trader1.publicKey, 1, BigInt(6_000_000_000));
    const leaf2 = makeLeaf(trader2.publicKey, 2, BigInt(4_000_000_000));
    const tree = new MerkleTree([leaf1, leaf2], keccak256, { sortPairs: true });

    const proof = tree.getProof(leaf1).map((p) => Array.from(p.data));

    const [claimReceiptPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("claimed"), compPDA.toBuffer(), trader1.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .claimReward(1, new anchor.BN(6_000_000_000), proof)
      .accounts({
        claimant: trader1.publicKey,
        competition: compPDA,
        prizeMint: prizeMint,
        vault: vaultPDA,
        claimantTokenAccount: trader1TokenAccount,
        claimReceipt: claimReceiptPDA,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([trader1])
      .rpc();

    const traderBalance = await getAccount(provider.connection, trader1TokenAccount);
    expect(Number(traderBalance.amount)).to.equal(6_000_000_000);
  });

  it("5. Rejects duplicate claim attempt (Sybil / Re-entrancy protection)", async () => {
    const makeLeaf = (wallet: PublicKey, rank: number, amount: bigint) => {
      const rankBuf = Buffer.alloc(4);
      rankBuf.writeUInt32LE(rank, 0);
      const amountBuf = Buffer.alloc(8);
      amountBuf.writeBigUInt64LE(amount, 0);
      return keccak256(Buffer.concat([wallet.toBuffer(), rankBuf, amountBuf]));
    };

    const leaf1 = makeLeaf(trader1.publicKey, 1, BigInt(6_000_000_000));
    const leaf2 = makeLeaf(trader2.publicKey, 2, BigInt(4_000_000_000));
    const tree = new MerkleTree([leaf1, leaf2], keccak256, { sortPairs: true });
    const proof = tree.getProof(leaf1).map((p) => Array.from(p.data));

    const [claimReceiptPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("claimed"), compPDA.toBuffer(), trader1.publicKey.toBuffer()],
      program.programId
    );

    let failed = false;
    try {
      await program.methods
        .claimReward(1, new anchor.BN(6_000_000_000), proof)
        .accounts({
          claimant: trader1.publicKey,
          competition: compPDA,
          prizeMint: prizeMint,
          vault: vaultPDA,
          claimantTokenAccount: trader1TokenAccount,
          claimReceipt: claimReceiptPDA,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([trader1])
        .rpc();
    } catch {
      failed = true;
    }
    expect(failed).to.be.true;
  });

  it("6. Rejects forged proof from unauthorized wallet", async () => {
    const makeLeaf = (wallet: PublicKey, rank: number, amount: bigint) => {
      const rankBuf = Buffer.alloc(4);
      rankBuf.writeUInt32LE(rank, 0);
      const amountBuf = Buffer.alloc(8);
      amountBuf.writeBigUInt64LE(amount, 0);
      return keccak256(Buffer.concat([wallet.toBuffer(), rankBuf, amountBuf]));
    };

    const leaf1 = makeLeaf(trader1.publicKey, 1, BigInt(6_000_000_000));
    const leaf2 = makeLeaf(trader2.publicKey, 2, BigInt(4_000_000_000));
    const tree = new MerkleTree([leaf1, leaf2], keccak256, { sortPairs: true });
    const proof = tree.getProof(leaf1).map((p) => Array.from(p.data));

    const attackerTokenAccount = await createAccount(
      provider.connection,
      attacker,
      prizeMint,
      attacker.publicKey
    );

    const [claimReceiptPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("claimed"), compPDA.toBuffer(), attacker.publicKey.toBuffer()],
      program.programId
    );

    let failed = false;
    try {
      await program.methods
        .claimReward(1, new anchor.BN(6_000_000_000), proof)
        .accounts({
          claimant: attacker.publicKey,
          competition: compPDA,
          prizeMint: prizeMint,
          vault: vaultPDA,
          claimantTokenAccount: attackerTokenAccount,
          claimReceipt: claimReceiptPDA,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([attacker])
        .rpc();
    } catch {
      failed = true;
    }
    expect(failed).to.be.true;
  });
});