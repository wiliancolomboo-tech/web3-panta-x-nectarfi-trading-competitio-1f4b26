import { keccak256 } from "ethereum-cryptography/keccak";
import { PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";

export interface ParticipantScore {
  pubkey: string;
  volumeUsd: number;
  pnlPercentage: number;
  nectarStakedWeight: number;
  finalScore: number;
  rewardAllocationRaw: bigint;
}

export class MerkleTreeEngine {
  private leaves: Buffer[];
  private layers: Buffer[][];

  constructor(elements: { claimant: PublicKey; amount: bigint }[]) {
    this.leaves = elements.map(el => this.hashLeaf(el.claimant, el.amount));
    this.leaves.sort(Buffer.compare);
    this.layers = [this.leaves];
    this.buildTree();
  }

  private hashLeaf(claimant: PublicKey, amount: bigint): Buffer {
    const amountBuffer = Buffer.alloc(8);
    amountBuffer.writeBigUInt64LE(amount);
    return Buffer.from(keccak256(Buffer.concat([claimant.toBuffer(), amountBuffer])));
  }

  private hashPair(a: Buffer, b: Buffer): Buffer {
    return Buffer.compare(a, b) <= 0
      ? Buffer.from(keccak256(Buffer.concat([a, b])))
      : Buffer.from(keccak256(Buffer.concat([b, a])));
  }

  private buildTree() {
    let currentLayer = this.leaves;
    while (currentLayer.length > 1) {
      const nextLayer: Buffer[] = [];
      for (let i = 0; i < currentLayer.length; i += 2) {
        if (i + 1 < currentLayer.length) {
          nextLayer.push(this.hashPair(currentLayer[i], currentLayer[i + 1]));
        } else {
          nextLayer.push(currentLayer[i]);
        }
      }
      this.layers.push(nextLayer);
      currentLayer = nextLayer;
    }
  }

  public getRoot(): Buffer {
    return this.layers[this.layers.length - 1][0] || Buffer.alloc(32, 0);
  }

  public getProof(claimant: PublicKey, amount: bigint): Buffer[] {
    const target = this.hashLeaf(claimant, amount);
    let index = -1;
    for (let i = 0; i < this.leaves.length; i++) {
      if (Buffer.compare(this.leaves[i], target) === 0) {
        index = i;
        break;
      }
    }

    if (index === -1) throw new Error("Leaf not found in tree");

    const proof: Buffer[] = [];
    for (let i = 0; i < this.layers.length - 1; i++) {
      const layer = this.layers[i];
      const isEven = index % 2 === 0;
      const pairIndex = isEven ? index + 1 : index - 1;

      if (pairIndex < layer.length) {
        proof.push(layer[pairIndex]);
      }
      index = Math.floor(index / 2);
    }
    return proof;
  }
}