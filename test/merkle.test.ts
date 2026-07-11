import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/receipt.js";
import { buildMerkleTree, getProof, hashLeaf, hashNode, verifyInclusion } from "../src/merkle.js";

function leaves(n: number): string[] {
  return Array.from({ length: n }, (_, i) => sha256Hex(`leaf-${i}`));
}

describe("merkle tree", () => {
  it("every leaf verifies inclusion against the root (even leaf count)", () => {
    const ls = leaves(8);
    const tree = buildMerkleTree(ls);
    for (let i = 0; i < ls.length; i++) {
      const proof = getProof(tree, i);
      expect(verifyInclusion(ls[i], proof, tree.root)).toBe(true);
    }
  });

  it("every leaf verifies inclusion against the root (odd leaf count, duplicated last node)", () => {
    const ls = leaves(5);
    const tree = buildMerkleTree(ls);
    for (let i = 0; i < ls.length; i++) {
      const proof = getProof(tree, i);
      expect(verifyInclusion(ls[i], proof, tree.root)).toBe(true);
    }
  });

  it("single-leaf tree has root equal to the domain-separated leaf hash, not the raw leaf", () => {
    const ls = leaves(1);
    const tree = buildMerkleTree(ls);
    expect(tree.root).toBe(hashLeaf(ls[0]));
    expect(tree.root).not.toBe(ls[0]);
    expect(verifyInclusion(ls[0], getProof(tree, 0), tree.root)).toBe(true);
  });

  it("rejects an inclusion proof for the wrong leaf", () => {
    const ls = leaves(6);
    const tree = buildMerkleTree(ls);
    const proofForZero = getProof(tree, 0);
    expect(verifyInclusion(ls[1], proofForZero, tree.root)).toBe(false);
  });

  it("rejects a proof against a tampered root", () => {
    const ls = leaves(4);
    const tree = buildMerkleTree(ls);
    const proof = getProof(tree, 2);
    const wrongRoot = sha256Hex("not-the-root");
    expect(verifyInclusion(ls[2], proof, wrongRoot)).toBe(false);
  });

  it("rejects a proof with a swapped/corrupted step", () => {
    const ls = leaves(8);
    const tree = buildMerkleTree(ls);
    const proof = getProof(tree, 3);
    const corrupted = proof.map((step) => ({ ...step, hash: sha256Hex(step.hash + "x") }));
    expect(verifyInclusion(ls[3], corrupted, tree.root)).toBe(false);
  });

  describe("leaf/node domain separation (reviewer CRITICAL forgery vector)", () => {
    it("rejects presenting an internal node's preimage as a leaf", () => {
      // Reviewer's exploit: attacker computes an internal node hash L = nodehash(P, Q),
      // then anchors [L, B] as if L were a real leaf. Without leaf/node domain
      // separation, presenting P alongside a fabricated proof [Q, B] can wrongly fold
      // back up to the same root — "proving" P is included when it never was a leaf.
      const [p, q, b] = leaves(3);
      const forgedLeaf = hashNode(p, q); // an internal-node hash, not real leaf data
      const tree = buildMerkleTree([forgedLeaf, b]);

      const forgedProof = [
        { hash: q, side: "right" as const },
        { hash: b, side: "right" as const },
      ];
      expect(verifyInclusion(p, forgedProof, tree.root)).toBe(false);

      // Sanity: the real leaf (forgedLeaf) with its real proof still verifies fine.
      const realProof = getProof(tree, 0);
      expect(verifyInclusion(forgedLeaf, realProof, tree.root)).toBe(true);
    });
  });

  describe("leaf-count binding (no duplicate-last-node collision)", () => {
    it("[A,B,C] and [A,B,C,C] produce different roots", () => {
      const [a, b, c] = leaves(3);
      const tree3 = buildMerkleTree([a, b, c]);
      const tree4 = buildMerkleTree([a, b, c, c]);
      expect(tree3.root).not.toBe(tree4.root);
    });

    it("distinct leaf counts never collide across a range of sizes", () => {
      const ls = leaves(9);
      const roots = new Set<string>();
      for (let n = 1; n <= ls.length; n++) {
        const tree = buildMerkleTree(ls.slice(0, n));
        roots.add(tree.root);
      }
      expect(roots.size).toBe(ls.length);
    });
  });
});
