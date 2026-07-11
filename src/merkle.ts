import { sha256Hex } from "./receipt.js";

export type MerkleSide = "left" | "right";

export interface MerkleProofStep {
  hash: string;
  side: MerkleSide;
}

export interface MerkleTree {
  root: string;
  /** Raw leaf data (e.g. receipt digests), NOT leaf-hashed. Leaf hashing happens on demand. */
  leaves: string[];
  leafCount: number;
}

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

/**
 * RFC-6962 leaf hash: sha256(0x00 || data). Domain-separated from internal nodes so an
 * attacker cannot present an internal node's preimage as if it were a leaf (or vice versa).
 */
export function hashLeaf(data: string): string {
  return sha256Hex(Buffer.concat([LEAF_PREFIX, Buffer.from(data, "hex")]));
}

/** RFC-6962 internal node hash: sha256(0x01 || left || right). */
export function hashNode(left: string, right: string): string {
  return sha256Hex(Buffer.concat([NODE_PREFIX, Buffer.from(left, "hex"), Buffer.from(right, "hex")]));
}

/** Largest power of two strictly less than n (n >= 2), per RFC-6962's MTH split rule. */
function splitPoint(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/**
 * RFC-6962 Merkle Tree Hash over leaves[lo:hi). Unlike naive pow-of-two padding with a
 * duplicated last node, this recursive left-balanced construction never re-derives the
 * same node hash for two different leaf counts: MTH([A,B,C]) and MTH([A,B,C,C]) provably
 * differ because the right subtree differs (a bare leaf hash vs. a pair of leaf hashes).
 */
function mth(leaves: string[], lo: number, hi: number): string {
  const n = hi - lo;
  if (n === 1) return hashLeaf(leaves[lo]);
  const k = splitPoint(n);
  const left = mth(leaves, lo, lo + k);
  const right = mth(leaves, lo + k, hi);
  return hashNode(left, right);
}

/** Builds an RFC-6962-style merkle tree over raw leaf data (hex digest strings). */
export function buildMerkleTree(leaves: string[]): MerkleTree {
  if (leaves.length === 0) {
    throw new Error("cannot build a merkle tree from zero leaves");
  }
  return {
    root: mth(leaves, 0, leaves.length),
    leaves: leaves.slice(),
    leafCount: leaves.length,
  };
}

function proofFor(leaves: string[], lo: number, hi: number, index: number, proof: MerkleProofStep[]): void {
  const n = hi - lo;
  if (n === 1) return;
  const k = splitPoint(n);
  if (index - lo < k) {
    proofFor(leaves, lo, lo + k, index, proof);
    proof.push({ hash: mth(leaves, lo + k, hi), side: "right" });
  } else {
    proofFor(leaves, lo + k, hi, index, proof);
    proof.push({ hash: mth(leaves, lo, lo + k), side: "left" });
  }
}

/** Returns the sibling-path inclusion proof (leaf-to-root order) for the leaf at leafIndex. */
export function getProof(tree: MerkleTree, leafIndex: number): MerkleProofStep[] {
  if (leafIndex < 0 || leafIndex >= tree.leafCount) {
    throw new Error(`leaf index ${leafIndex} out of range`);
  }
  const proof: MerkleProofStep[] = [];
  proofFor(tree.leaves, 0, tree.leaves.length, leafIndex, proof);
  return proof;
}

/**
 * Recomputes the root from raw leaf data + proof and checks it matches the expected root.
 * The leaf is hashed here with the 0x00 domain-separation prefix before folding the proof
 * upward with 0x01-prefixed internal node hashes, so an internal node's preimage can never
 * be replayed as a valid leaf.
 */
export function verifyInclusion(leafData: string, proof: MerkleProofStep[], expectedRoot: string): boolean {
  let computed = hashLeaf(leafData);
  for (const step of proof) {
    computed = step.side === "left" ? hashNode(step.hash, computed) : hashNode(computed, step.hash);
  }
  return computed === expectedRoot;
}
