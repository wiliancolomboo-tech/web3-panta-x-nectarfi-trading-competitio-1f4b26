import { MerkleTree } from 'merkletreejs';
import keccak256 from 'keccak256';
import { PublicKey } from '@solana/web3.js';
import * as borsh from 'borsh';

export interface WinnerLeaf {
  trader: PublicKey;
  rewardAmount: bigint;
}

export function buildCompetitionTree(leaves: WinnerLeaf[]): { tree: MerkleTree; root: Buffer } {
  const elements = leaves.map((leaf) => {
    const amountBuf = Buffer.alloc(8);
    amountBuf.writeBigUInt64LE(leaf.rewardAmount, 0);
    return keccak256(Buffer.concat([leaf.trader.toBuffer(), amountBuf]));
  });

  const tree = new MerkleTree(elements, keccak256, { sortPairs: true });
  const root = tree.getRoot();
  return { tree, root };
}

export function getProofForTrader(tree: MerkleTree, trader: PublicKey, amount: bigint): Buffer[] {
  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(amount, 0);
  const targetLeaf = keccak256(Buffer.concat([trader.toBuffer(), amountBuf]));
  return tree.getProof(targetLeaf).map((p) => p.data);
}