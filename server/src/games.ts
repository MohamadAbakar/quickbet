// Off-chain game rules (spec section 6). Pure functions over plain JSON state.
// Every game ends by producing a payout vector in seat order (base units)
// that sums to buyIn * players.

export interface GameCtx {
  n: number; // seats
  buyIn: number; // base units
  host: number; // seat index of host (always 0)
  target: number; // score match target
}

export class RuleError extends Error {}
const fail = (msg: string): never => {
  throw new RuleError(msg);
};

// ---------------- Score match ----------------
export interface MatchState {
  kind: "match";
  scores: number[];
  target: number;
  winner: number | null;
  log: { by: number; seat: number; delta: number; at: number }[];
}

export function matchInit(ctx: GameCtx): MatchState {
  return {
    kind: "match",
    scores: Array(ctx.n).fill(0),
    target: ctx.target > 0 ? ctx.target : 5,
    winner: null,
    log: [],
  };
}

export function matchAct(s: MatchState, by: number, a: any): MatchState {
  if (a.type !== "score") fail("Unknown action");
  const seat = Number(a.seat);
  const delta = a.delta > 0 ? 1 : -1;
  if (!(seat >= 0 && seat < s.scores.length)) fail("No such seat");
  if (delta > 0 && s.winner !== null) fail("We already have a winner");
  const scores = s.scores.slice();
  scores[seat] = Math.max(0, Math.min(s.target, scores[seat] + delta));
  let winner = s.winner;
  if (scores[seat] === s.target && winner === null) winner = seat;
  if (seat === winner && scores[seat] < s.target) winner = null;
  const log = [{ by, seat, delta, at: Date.now() }, ...s.log].slice(0, 12);
  return { ...s, scores, winner, log };
}

export function matchResult(s: MatchState, ctx: GameCtx): number[] | null {
  if (s.winner === null) return null;
  const v = Array(ctx.n).fill(0);
  v[s.winner] = ctx.buyIn * ctx.n;
  return v;
}

// ---------------- Pick a side ----------------
export type Side = "yes" | "no";
export interface SideState {
  kind: "side";
  picks: (Side | null)[];
  locked: boolean;
  calls: (Side | null)[];
  outcome: Side | null;
}

export function sideInit(ctx: GameCtx): SideState {
  return {
    kind: "side",
    picks: Array(ctx.n).fill(null),
    locked: false,
    calls: Array(ctx.n).fill(null),
    outcome: null,
  };
}

const asSide = (x: any): Side => (x === "yes" || x === "no" ? x : fail("Pick yes or no"));

export function sideAct(s: SideState, by: number, a: any, ctx: GameCtx): SideState {
  switch (a.type) {
    case "pick": {
      if (s.locked) fail("Sides are locked");
      const picks = s.picks.slice();
      picks[by] = asSide(a.side);
      return { ...s, picks };
    }
    case "lock": {
      if (by !== ctx.host) fail("Only the host can lock sides");
      if (s.locked) return s;
      if (s.picks.some((p) => p === null)) fail("Everyone needs to pick a side first");
      const yes = s.picks.filter((p) => p === "yes").length;
      if (yes === 0 || yes === s.picks.length)
        fail("Everyone is on the same side, so there is nothing to win. Someone has to switch.");
      return { ...s, locked: true };
    }
    case "call": {
      if (!s.locked) fail("Lock sides first");
      if (s.outcome) return s;
      const calls = s.calls.slice();
      calls[by] = asSide(a.side);
      const n = calls.length;
      let outcome: Side | null = null;
      for (const side of ["yes", "no"] as Side[]) {
        if (calls.filter((c) => c === side).length * 2 > n) outcome = side;
      }
      return { ...s, calls, outcome };
    }
  }
  return fail("Unknown action");
}

export function sideResult(s: SideState, ctx: GameCtx): number[] | null {
  if (!s.outcome) return null;
  const winners = s.picks.map((p, i) => (p === s.outcome ? i : -1)).filter((i) => i >= 0);
  const pot = ctx.buyIn * ctx.n;
  const share = Math.floor(pot / winners.length);
  const v = Array(ctx.n).fill(0);
  winners.forEach((i) => (v[i] = share));
  v[winners[0]] += pot - share * winners.length; // remainder to lowest seat
  return v;
}

// ---------------- Poker table (chip tracker) ----------------
export type PokerPhase = "bet" | "street_done" | "showdown" | "hand_over";
export interface PokerState {
  kind: "poker";
  stacks: number[]; // chips behind (not in the pot)
  hand: number;
  dealer: number;
  sbSeat: number;
  bbSeat: number;
  sb: number;
  bb: number;
  street: number; // 0 preflop .. 3 river
  phase: PokerPhase;
  inHand: boolean[];
  committed: number[]; // this hand
  bets: number[]; // this street
  currentBet: number;
  minRaise: number;
  toAct: number | null;
  acted: boolean[];
  cap: number; // max total commitment this hand (smallest stack) → no side pots
  showVotes: (string | null)[];
  lastResult: string | null;
  lastActions: (string | null)[];
  cashedOut: boolean;
}

const STREETS = ["Preflop", "Flop", "Turn", "River"];
export const streetName = (i: number) => STREETS[i] ?? "River";

function nextSeat(s: PokerState, from: number, pred: (i: number) => boolean): number | null {
  const n = s.stacks.length;
  for (let k = 1; k <= n; k++) {
    const i = (from + k) % n;
    if (pred(i)) return i;
  }
  return null;
}

const canAct = (s: PokerState, i: number) =>
  s.inHand[i] && s.stacks[i] > 0 && s.committed[i] < s.cap;

function post(s: PokerState, i: number, amount: number) {
  const a = Math.max(0, Math.min(amount, s.stacks[i], s.cap - s.committed[i]));
  s.stacks[i] -= a;
  s.committed[i] += a;
  s.bets[i] += a;
  return a;
}

const pot = (s: PokerState) => s.committed.reduce((a, b) => a + b, 0);

function startHand(prev: PokerState, first: boolean): PokerState {
  const n = prev.stacks.length;
  const s: PokerState = {
    ...prev,
    stacks: prev.stacks.slice(),
    committed: Array(n).fill(0),
    bets: Array(n).fill(0),
    acted: Array(n).fill(false),
    showVotes: Array(n).fill(null),
    lastActions: Array(n).fill(null),
    street: 0,
    currentBet: 0,
    minRaise: prev.bb,
    lastResult: first ? null : prev.lastResult,
  };
  const active = s.stacks.map((x) => x > 0);
  s.inHand = active.slice();
  if (active.filter(Boolean).length < 2) {
    s.phase = "hand_over";
    s.toAct = null;
    s.lastResult = "Only one player has chips left. Cash out the table.";
    return s;
  }
  if (!first || !active[s.dealer]) {
    s.dealer = nextSeat(s, s.dealer, (i) => active[i])!;
  }
  s.cap = Math.min(...s.stacks.filter((x) => x > 0));
  const heads = active.filter(Boolean).length === 2;
  s.sbSeat = heads ? s.dealer : nextSeat(s, s.dealer, (i) => active[i])!;
  s.bbSeat = nextSeat(s, s.sbSeat, (i) => active[i])!;
  post(s, s.sbSeat, s.sb);
  post(s, s.bbSeat, s.bb);
  s.lastActions[s.sbSeat] = "Small blind";
  s.lastActions[s.bbSeat] = "Big blind";
  s.currentBet = Math.max(...s.bets);
  s.phase = "bet";
  s.toAct = nextSeat(s, s.bbSeat, (i) => canAct(s, i));
  if (s.toAct === null) s.phase = "street_done";
  return s;
}

export function pokerInit(ctx: GameCtx): PokerState {
  const sb = Math.max(1, Math.floor(ctx.buyIn / 20));
  const bb = Math.max(2, Math.floor(ctx.buyIn / 10));
  const base: PokerState = {
    kind: "poker",
    stacks: Array(ctx.n).fill(ctx.buyIn),
    hand: 1,
    dealer: 0,
    sbSeat: 0,
    bbSeat: 0,
    sb,
    bb,
    street: 0,
    phase: "bet",
    inHand: Array(ctx.n).fill(true),
    committed: [],
    bets: [],
    currentBet: 0,
    minRaise: bb,
    toAct: null,
    acted: [],
    cap: ctx.buyIn,
    showVotes: [],
    lastResult: null,
    lastActions: [],
    cashedOut: false,
  };
  return startHand(base, true);
}

function roundDone(s: PokerState) {
  for (let i = 0; i < s.stacks.length; i++) {
    if (!canAct(s, i)) continue;
    if (!s.acted[i] || s.bets[i] < s.currentBet) return false;
  }
  return true;
}

function awardLastStanding(s: PokerState) {
  const w = s.inHand.findIndex(Boolean);
  const p = pot(s);
  s.stacks[w] += p;
  s.lastResult = JSON.stringify({ winners: [w], pot: p, folded: true });
  s.committed = s.committed.map(() => 0);
  s.phase = "hand_over";
  s.toAct = null;
}

/** Max total "raise to" amount this street for a seat. */
export const maxRaiseTo = (s: PokerState, i: number) =>
  s.bets[i] + Math.min(s.stacks[i], s.cap - s.committed[i]);
export const minRaiseTo = (s: PokerState, i: number) =>
  Math.min(s.currentBet + s.minRaise, maxRaiseTo(s, i));

export function pokerAct(prev: PokerState, by: number, a: any, ctx: GameCtx): PokerState {
  const s: PokerState = JSON.parse(JSON.stringify(prev));
  const isRunner = by === ctx.host || by === s.dealer;
  switch (a.type) {
    case "fold":
    case "check":
    case "call":
    case "raise": {
      if (s.phase !== "bet") fail("Betting is closed");
      if (s.toAct !== by) fail("It's not your turn");
      if (a.type === "fold") {
        s.inHand[by] = false;
        s.lastActions[by] = "Folded";
        if (s.inHand.filter(Boolean).length === 1) {
          awardLastStanding(s);
          return s;
        }
      } else if (a.type === "check") {
        if (s.bets[by] !== s.currentBet) fail("You can't check, there's a bet to call");
        s.lastActions[by] = "Checked";
      } else if (a.type === "call") {
        const owed = s.currentBet - s.bets[by];
        if (owed <= 0) {
          s.lastActions[by] = "Checked";
        } else {
          post(s, by, owed);
          s.lastActions[by] = s.bets[by] < s.currentBet ? "All in" : "Called";
        }
      } else {
        const to = Math.floor(Number(a.to));
        const max = maxRaiseTo(s, by);
        if (!(to > s.currentBet)) fail("A raise has to be bigger than the current bet");
        if (to > max) fail("That's above the max bet this hand");
        if (to < s.currentBet + s.minRaise && to !== max)
          fail("Minimum raise is the size of the last raise");
        s.minRaise = Math.max(s.minRaise, to - s.currentBet);
        s.currentBet = to;
        post(s, by, to - s.bets[by]);
        s.acted = s.acted.map(() => false);
        s.lastActions[by] = "Raised";
      }
      s.acted[by] = true;
      if (roundDone(s)) {
        s.phase = "street_done";
        s.toAct = null;
      } else {
        s.toAct = nextSeat(
          s,
          by,
          (i) => canAct(s, i) && (!s.acted[i] || s.bets[i] < s.currentBet)
        );
      }
      return s;
    }
    case "next_street": {
      if (!isRunner) fail("Only the dealer or host can deal the next street");
      if (s.phase !== "street_done") fail("Finish the betting round first");
      if (s.street >= 3) fail("That was the river. Go to showdown.");
      s.street += 1;
      s.bets = s.bets.map(() => 0);
      s.currentBet = 0;
      s.minRaise = s.bb;
      s.acted = s.acted.map(() => false);
      s.lastActions = s.lastActions.map((x, i) => (s.inHand[i] ? null : x));
      s.toAct = nextSeat(s, s.dealer, (i) => canAct(s, i));
      s.phase = s.toAct === null ? "street_done" : "bet";
      // A single player who can still act has nobody to bet against.
      if (s.phase === "bet" && s.stacks.filter((_, i) => canAct(s, i)).length < 2) {
        s.phase = "street_done";
        s.toAct = null;
      }
      return s;
    }
    case "showdown": {
      if (!isRunner) fail("Only the dealer or host can call showdown");
      if (s.phase !== "street_done") fail("Finish the betting round first");
      s.phase = "showdown";
      s.showVotes = s.showVotes.map(() => null);
      return s;
    }
    case "show_vote": {
      if (s.phase !== "showdown") fail("Not at showdown");
      if (!s.inHand[by]) fail("Only players still in the hand pick the winner");
      const winners: number[] = (Array.isArray(a.winners) ? a.winners : [])
        .map(Number)
        .filter((i: number) => s.inHand[i]);
      const uniq = [...new Set(winners)].sort((x, y) => x - y);
      if (uniq.length < 1 || uniq.length > 2) fail("Pick one winner, or two to split the pot");
      s.showVotes[by] = uniq.join(",");
      const voters = s.inHand.filter(Boolean).length;
      const key = s.showVotes[by]!;
      const agree = s.showVotes.filter((v, i) => s.inHand[i] && v === key).length;
      if (agree * 2 > voters) {
        const p = pot(s);
        if (uniq.length === 1) {
          s.stacks[uniq[0]] += p;
        } else {
          const half = Math.floor(p / 2);
          s.stacks[uniq[0]] += p - half; // lower seat gets any remainder
          s.stacks[uniq[1]] += half;
        }
        s.lastResult = JSON.stringify({ winners: uniq, pot: p, folded: false });
        s.committed = s.committed.map(() => 0);
        s.phase = "hand_over";
      }
      return s;
    }
    case "next_hand": {
      if (by !== ctx.host) fail("Only the host can deal the next hand");
      if (s.phase !== "hand_over") fail("Finish this hand first");
      const next = startHand({ ...s, hand: s.hand + 1 }, false);
      return next;
    }
    case "cash_out": {
      if (by !== ctx.host) fail("Only the host can cash out the table");
      if (s.phase !== "hand_over") fail("Finish this hand before cashing out");
      s.cashedOut = true;
      return s;
    }
  }
  return fail("Unknown action");
}

export function pokerResult(s: PokerState): number[] | null {
  return s.cashedOut ? s.stacks.slice() : null;
}

// ---------------- dispatch ----------------
export type GameState = MatchState | SideState | PokerState;

export function initGame(mode: number, ctx: GameCtx): GameState {
  if (mode === 0) return pokerInit(ctx);
  if (mode === 1) return sideInit(ctx);
  return matchInit(ctx);
}

export function applyAction(g: GameState, by: number, a: any, ctx: GameCtx): GameState {
  if (g.kind === "match") return matchAct(g, by, a);
  if (g.kind === "side") return sideAct(g, by, a, ctx);
  return pokerAct(g, by, a, ctx);
}

export function gameResult(g: GameState, ctx: GameCtx): number[] | null {
  const v =
    g.kind === "match" ? matchResult(g, ctx) : g.kind === "side" ? sideResult(g, ctx) : pokerResult(g);
  if (v) {
    const sum = v.reduce((a, b) => a + b, 0);
    if (sum !== ctx.buyIn * ctx.n) throw new Error(`payout sum ${sum} != pot ${ctx.buyIn * ctx.n}`);
  }
  return v;
}
