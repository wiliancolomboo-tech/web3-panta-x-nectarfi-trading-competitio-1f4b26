// File: tests/panta_nectar_arena.spec.ts

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PantaNectarArena } from "../target/types/panta_nectar_arena";
import { 
    TOKEN_PROGRAM_ID, 
    createMint, 
    createAccount, 
    mintTo, 
    getAccount 
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

describe("panta_nectar_arena full lifecycle tests", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const program = anchor.workspace.PantaNectarArena as Program<PantaNectarArena>;
    const admin = Keypair.generate();
    const oracle = Keypair.generate();
    const trader1 = Keypair.generate();
    const trader2 = Keypair.generate();
    const trader3 = Keypair.generate();

    let rewardMint: PublicKey;
    let competitionId = new anchor.BN(Math.floor(Date.now() / 1000));
    let competitionPda: PublicKey;
    let vaultPda: PublicKey;

    const entryFee = new anchor.BN(10_000_000); // 10 USDC (6 decimals)
    const minTradeVolume = new anchor.BN(100_000_000); // 100 USDC
    const rewardBps = [5000, 3000, 2000]; // 50%, 30%, 20%

    let trader1TokenAccount: PublicKey;
    let trader2TokenAccount: PublicKey;
    let trader3TokenAccount: PublicKey;

    before(async () => {
        // Airdrop SOL to test actors
        for (const actor of [admin, oracle, trader1, trader2, trader3]) {
            const sig = await provider.connection.requestAirdrop(actor.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
            await provider.connection.confirmTransaction(sig, "confirmed");
        }

        // Create Reward Token Mint (USDC simulation)
        rewardMint = await createMint(
            provider.connection,
            admin,
            admin.publicKey,
            null,
            6
        );

        // Derive Competition and Vault PDAs
        [competitionPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("competition"), competitionId.toArrayLike(Buffer, "le", 8)],
            program.programId
        );

        [vaultPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("vault"), competitionPda.toBuffer()],
            program.programId
        );

        // Create Token Accounts for Traders and fund them
        trader1TokenAccount = await createAccount(provider.connection, trader1, rewardMint, trader1.publicKey);
        trader2TokenAccount = await createAccount(provider.connection, trader2, rewardMint, trader2.publicKey);
        trader3TokenAccount = await createAccount(provider.connection, trader3, rewardMint, trader3.publicKey);

        await mintTo(provider.connection, admin, rewardMint, trader1TokenAccount, admin, 1_000_000_000);
        await mintTo(provider.connection, admin, rewardMint, trader2TokenAccount, admin, 1_000_000_000);
        await mintTo(provider.connection, admin, rewardMint, trader3TokenAccount, admin, 1_000_000_000);
    });

    it("1. Initializes competition successfully", async () => {
        const startTs = new anchor.BN(Math.floor(Date.now() / 1000));
        const endTs = startTs.add(new anchor.BN(10)); // 10 seconds duration

        await program.methods
            .initializeCompetition(
                competitionId,
                startTs,
                endTs,
                entryFee,
                minTradeVolume,
                rewardBps
            )
            .accounts({
                competition: competitionPda,
                rewardMint: rewardMint,
                prizeVault: vaultPda,
                oracle: oracle.publicKey,
                admin: admin.publicKey,
                systemProgram: SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
                rent: anchor.web3.SYSVAR_RENT_PUBKEY,
            })
            .signers([admin])
            .rpc();

        const competitionAccount = await program.account.competitionState.fetch(competitionPda);
        expect(competitionAccount.competitionId.toString()).to.equal(competitionId.toString());
        expect(competitionAccount.admin.toBase58()).to.equal(admin.publicKey.toBase58());
        expect(competitionAccount.oracle.toBase58()).to.equal(oracle.publicKey.toBase58());
        expect(competitionAccount.isSettled).to.be.false;
    });

    it("2. Registers participants and escrows entry fee", async () => {
        for (const trader of [trader1, trader2, trader3]) {
            const [participantPda] = PublicKey.findProgramAddressSync(
                [Buffer.from("participant"), competitionPda.toBuffer(), trader.publicKey.toBuffer()],
                program.programId
            );

            const traderAta = trader.publicKey.equals(trader1.publicKey)
                ? trader1TokenAccount
                : trader.publicKey.equals(trader2.publicKey)
                ? trader2TokenAccount
                : trader3TokenAccount;

            await program.methods
                .registerParticipant()
                .accounts({
                    competition: competitionPda,
                    participant: participantPda,
                    prizeVault: vaultPda,
                    userTokenAccount: traderAta,
                    trader: trader.publicKey,
                    systemProgram: SystemProgram.programId,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([trader])
                .rpc();

            const pAccount = await program.account.participantState.fetch(participantPda);
            expect(pAccount.trader.toBase58()).to.equal(trader.publicKey.toBase58());
            expect(pAccount.volume.toNumber()).to.equal(0);
        }

        const vaultTokenAccount = await getAccount(provider.connection, vaultPda);
        expect(Number(vaultTokenAccount.amount)).to.equal(entryFee.toNumber() * 3);
    });

    it("3. Oracle records verifiable trades and accumulates PnL", async () => {
        const [p1Pda] = PublicKey.findProgramAddressSync(
            [Buffer.from("participant"), competitionPda.toBuffer(), trader1.publicKey.toBuffer()],
            program.programId
        );

        // Trade 1: $500 Volume, +$50 PnL
        await program.methods
            .recordTrade(new anchor.BN(500_000_000), new anchor.BN(50_000_000))
            .accounts({
                competition: competitionPda,
                participant: p1Pda,
                oracle: oracle.publicKey,
            })
            .signers([oracle])
            .rpc();

        const pAccount = await program.account.participantState.fetch(p1Pda);
        expect(pAccount.volume.toNumber()).to.equal(500_000_000);
        expect(pAccount.realizedPnl.toString()).to.equal("50000000");
    });

    it("4. Prevents early settlement before end timestamp", async () => {
        try {
            await program.methods
                .settleCompetition([trader1.publicKey, trader2.publicKey, trader3.publicKey])
                .accounts({
                    competition: competitionPda,
                    prizeVault: vaultPda,
                    oracle: oracle.publicKey,
                })
                .signers([oracle])
                .rpc();
            expect.fail("Should have thrown ArenaError::CompetitionStillActive");
        } catch (err: any) {
            expect(err.error.errorCode.code).to.equal("CompetitionStillActive");
        }
    });

    it("5. Settles competition successfully after time passes", async () => {
        // Wait for end_ts to lapse
        await new Promise((resolve) => setTimeout(resolve, 11000));

        await program.methods
            .settleCompetition([trader1.publicKey, trader2.publicKey, trader3.publicKey])
            .accounts({
                competition: competitionPda,
                prizeVault: vaultPda,
                oracle: oracle.publicKey,
            })
            .signers([oracle])
            .rpc();

        const comp = await program.account.competitionState.fetch(competitionPda);
        expect(comp.isSettled).to.be.true;
        expect(comp.winner1.toBase58()).to.equal(trader1.publicKey.toBase58());
        expect(comp.winner2.toBase58()).to.equal(trader2.publicKey.toBase58());
        expect(comp.winner3.toBase58()).to.equal(trader3.publicKey.toBase58());
    });

    it("6. Winner claims 1st place prize (50% of vault)", async () => {
        const [p1Pda] = PublicKey.findProgramAddressSync(
            [Buffer.from("participant"), competitionPda.toBuffer(), trader1.publicKey.toBuffer()],
            program.programId
        );

        const balanceBefore = (await getAccount(provider.connection, trader1TokenAccount)).amount;

        await program.methods
            .claimReward()
            .accounts({
                competition: competitionPda,
                participant: p1Pda,
                prizeVault: vaultPda,
                traderTokenAccount: trader1TokenAccount,
                trader: trader1.publicKey,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([trader1])
            .rpc();

        const balanceAfter = (await getAccount(provider.connection, trader1TokenAccount)).amount;
        const totalPrizePool = entryFee.toNumber() * 3; // 30 USDC
        const expectedReward = totalPrizePool * 0.50;   // 15 USDC

        expect(Number(balanceAfter - balanceBefore)).to.equal(expectedReward);

        const pAccount = await program.account.participantState.fetch(p1Pda);
        expect(pAccount.hasClaimed).to.be.true;
        expect(pAccount.finalRank).to.equal(1);
    });

    it("7. Prevents double claim exploits", async () => {
        const [p1Pda] = PublicKey.findProgramAddressSync(
            [Buffer.from("participant"), competitionPda.toBuffer(), trader1.publicKey.toBuffer()],
            program.programId
        );

        try {
            await program.methods
                .claimReward()
                .accounts({
                    competition: competitionPda,
                    participant: p1Pda,
                    prizeVault: vaultPda,
                    traderTokenAccount: trader1TokenAccount,
                    trader: trader1.publicKey,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([trader1])
                .rpc();
            expect.fail("Should have failed on RewardAlreadyClaimed");
        } catch (err: any) {
            expect(err.error.errorCode.code).to.equal("RewardAlreadyClaimed");
        }
    });
});