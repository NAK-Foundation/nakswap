// Cycle safeguards. Below `lowCycles` the router stops taking new orders and stops
// starting new swaps (ICP that arrives just waits in its deposit account). Payouts and
// refunds for swaps already done keep running until `criticalCycles`, so nobody is left
// with funds mid-flight. The canister's freezing threshold (set to ~90 days of idle
// burn) is the last line: the IC freezes it with its state intact instead of deleting it.
module {
  public let lowCycles : Nat = 500_000_000_000; // 0.5T
  public let criticalCycles : Nat = 150_000_000_000; // 0.15T

  // Anti-spam / anti-drain limits.
  // Ingress messages bigger than this are rejected before they cost the canister anything.
  public let maxArgBytes : Nat = 2_048;
  // At most this many open orders (waiting for ICP, or paying out). Bounds the background
  // polling, which is where an order spammer could otherwise burn cycles.
  public let maxOpenOrders : Nat = 150;
  // The background worker checks a waiting deposit account at most this often (60 s).
  public let recheckNanos : Int = 60_000_000_000;
  // An order the relay never paired with a Houdini exchange is deleted after this (15 min):
  // nobody was ever shown where to pay, so nothing can arrive.
  public let unattachedTtlSeconds : Nat = 900;
  // Most orders one tick walks per phase (payouts/refunds, then deposit checks).
  public let maxPerTick : Nat = 10;

  // Late deposits: an expired order's deposit account is re-checked about every 10 minutes
  // (most overdue first) for 3 days after its window closed. ICP that turns up (a slow
  // exchange withdrawal, a late Houdini delivery, a direct ICP payment sent after the
  // window) revives the order, which then swaps or refunds as usual. At most `lateChecksPerTick` checks per tick, and at most
  // `maxLateWatch` orders watched at once.
  public let lateCheckNanos : Int = 600_000_000_000; // 10 min
  public let lateWatchNanos : Int = 259_200_000_000_000; // 3 days
  public let lateChecksPerTick : Nat = 10;
  public let maxLateWatch : Nat = 3_000;

  // Privacy: Houdini order ids (the link back to the user's sending wallet) are forgotten
  // this long after an order completes or is refunded.
  public let forgetHoudiniAfterNanos : Int = 2_592_000_000_000_000; // 30 days
};
