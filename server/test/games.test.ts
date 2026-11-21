import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyAction,
  gameResult,
  initGame,
  type GameCtx,
  type PokerState,
  type SideState,
  type MatchState,
} from "../src/games.ts";

const B = 10_000_000; // 10 USDC
const ctx = (n: number, target = 5): GameCtx => ({ n, buyIn: B, host: 0, target });
const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);

test("score match: first to target takes the pot; minus un-wins", () => {
  const c = ctx(4, 3);
  let g = initGame(2, c) as MatchState;
  for (let i = 0; i < 3; i++) g = applyAction(g, 0, { type: "score", seat: 2, delta: 1 }, c) as MatchState;
  assert.equal(g.winner, 2);
  assert.deepEqual(gameResult(g, c), [0, 0, 4 * B, 0]);
  assert.throws(() => applyAction(g, 1, { type: "score", seat: 1, delta: 1 }, c));
  g = applyAction(g, 1, { type: "score", seat: 2, delta: -1 }, c) as MatchState;
  assert.equal(g.winner, null);
  assert.equal(gameResult(g, c), null);
});

test("pick a side: lock rules, majority call, remainder to lowest winner seat", () => {
  const c: GameCtx = { n: 3, buyIn: 5, host: 0, target: 0 };
  let g = initGame(1, c) as SideState;
  for (const [seat, side] of [[0, "yes"], [1, "yes"], [2, "yes"]] as const)
    g = applyAction(g, seat, { type: "pick", side }, c) as SideState;
  assert.throws(() => applyAction(g, 0, { type: "lock" }, c), /same side/);
  g = applyAction(g, 2, { type: "pick", side: "no" }, c) as SideState;
  assert.throws(() => applyAction(g, 1, { type: "lock" }, c), /host/);
  g = applyAction(g, 0, { type: "lock" }, c) as SideState;
  assert.throws(() => applyAction(g, 2, { type: "pick", side: "yes" }, c));
  g = applyAction(g, 0, { type: "call", side: "yes" }, c) as SideState;
  assert.equal(g.outcome, null);
  g = applyAction(g, 2, { type: "call", side: "yes" }, c) as SideState;
  assert.equal(g.outcome, "yes");
  assert.deepEqual(gameResult(g, c), [8, 7, 0]); // 15 split 2 ways, remainder to seat 0
});

function play(g: PokerState, c: GameCtx, seat: number, action: any) {
  return applyAction(g, seat, action, c) as PokerState;
}

test("poker: blinds, fold-out, showdown majority, split, cash out sums to pot", () => {
  const c = ctx(4);
  let g = initGame(0, c) as PokerState;
  // dealer 0, sb 1, bb 2, first to act 3
  assert.equal(g.sb, B / 20);
  assert.equal(g.bb, B / 10);
  assert.equal(g.toAct, 3);
  assert.equal(g.committed[1] + g.committed[2], (3 * B) / 20);
  assert.throws(() => play(g, c, 0, { type: "call" }), /turn/);

  g = play(g, c, 3, { type: "call" });
  g = play(g, c, 0, { type: "raise", to: 4 * g.bb });
  g = play(g, c, 1, { type: "fold" });
  g = play(g, c, 2, { type: "call" });
  g = play(g, c, 3, { type: "call" });
  assert.equal(g.phase, "street_done");
  g = play(g, c, 0, { type: "next_street" });
  assert.equal(g.street, 1);
  for (const s of [2, 3, 0]) g = play(g, c, s, { type: "check" });
  assert.equal(g.phase, "street_done");
  g = play(g, c, 0, { type: "showdown" });
  assert.throws(() => play(g, c, 1, { type: "show_vote", winners: [0] }), /still in the hand/);
  g = play(g, c, 0, { type: "show_vote", winners: [0, 3] });
  g = play(g, c, 2, { type: "show_vote", winners: [0, 3] });
  assert.equal(g.phase, "hand_over");
  assert.equal(sum(g.stacks), 4 * B);
  assert.ok(g.stacks[0] > B && g.stacks[3] > B);

  // Hand 2: everyone folds to the big blind.
  g = play(g, c, 0, { type: "next_hand" });
  assert.equal(g.dealer, 1);
  while (g.phase === "bet") g = play(g, c, g.toAct!, { type: "fold" });
  assert.equal(g.phase, "hand_over");
  assert.equal(sum(g.stacks), 4 * B);

  assert.throws(() => play(g, c, 1, { type: "cash_out" }), /host/);
  g = play(g, c, 0, { type: "cash_out" });
  const v = gameResult(g, c)!;
  assert.equal(sum(v), 4 * B);
});

test("poker: bets are capped at the smallest stack (no side pots)", () => {
  const c = ctx(2);
  let g = initGame(0, c) as PokerState;
  // heads-up: dealer (0) is small blind and acts first preflop
  assert.equal(g.sbSeat, 0);
  assert.equal(g.toAct, 0);
  g = play(g, c, 0, { type: "raise", to: B }); // all-in to the cap
  assert.throws(() => play(g, c, 1, { type: "raise", to: B + 1 }), /max bet/);
  g = play(g, c, 1, { type: "call" });
  assert.equal(g.phase, "street_done");
  g = play(g, c, 0, { type: "showdown" });
  g = play(g, c, 0, { type: "show_vote", winners: [1] });
  assert.equal(g.phase, "showdown"); // 1 of 2 is not a majority
  g = play(g, c, 1, { type: "show_vote", winners: [1] });
  assert.deepEqual(g.stacks, [0, 2 * B]);
  g = play(g, c, 0, { type: "next_hand" });
  assert.equal(g.phase, "hand_over"); // only one player with chips
  g = play(g, c, 0, { type: "cash_out" });
  assert.deepEqual(gameResult(g, c), [0, 2 * B]);
});
