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
  // (50 s, so a 60 s worker tick checks each waiting order every tick.)
  public let recheckNanos : Int = 50_000_000_000;
  // An order the relay never paired with a Houdini exchange is deleted after this (15 min):
  // nobody was ever shown where to pay, so nothing can arrive.
  public let unattachedTtlSeconds : Nat = 900;
  // Most orders one tick walks per phase (payouts/refunds, then deposit checks).
  public let maxPerTick : Nat = 10;

  // Late deposits: an expired order's deposit account is re-checked (most overdue first)
  // for 3 days after its window closed: every 10 minutes for the first 6 hours, hourly
  // until 24 hours, then every 6 hours. ICP that turns up (a slow exchange withdrawal, a
  // late Houdini delivery, a direct ICP payment sent after the window) revives the order,
  // which then swaps or refunds as usual. Finished (completed or refunded) orders are
  // watched too, for ICP sent after the swap. At most `lateChecksPerTick` checks per tick
  // and `maxLateWatch` orders watched at once.
  public let lateCheckNanos : Int = 600_000_000_000; // 10 min
  public let lateFastNanos : Int = 21_600_000_000_000; // 6 h
  public let lateHourlyNanos : Int = 3_600_000_000_000; // 1 h
  public let lateHourlyUntilNanos : Int = 86_400_000_000_000; // 24 h
  public let lateSlowNanos : Int = 21_600_000_000_000; // 6 h
  public let lateWatchNanos : Int = 259_200_000_000_000; // 3 days
  public let lateChecksPerTick : Nat = 10;
  public let maxLateWatch : Nat = 3_000;
  // Anti-dust floor (0.5 ICP, and never more than half the minimum order, so a lowered
  // minimum can't leave real payments below the floor). Less than this in a deposit account is dust, not a
  // payment: it doesn't start a swap or a refund on a waiting order, doesn't revive an
  // expired or finished one, and doesn't stop the relay cancelling an unpaid order. Anyone
  // can send dust (e.g. look-alike "address poisoning" transfers); acting on it would only
  // spend cycles and ledger fees. Between the floor and the minimum order, ICP is refunded
  // as too small. When an order's
  // late-deposit watch ends, whatever dust is left (ICP and NAK) is moved to the router's
  // stray account (admin: recoverStray), never while the order could still be paid.
  public let minDepositE8s : Nat = 50_000_000;

  // Price guard: a swap waits if the pool's live price is this much worse than its recent
  // average (3%); an average older than 10 minutes is ignored (rebuilt from fresh samples).
  public let priceGuardBps : Nat = 300;
  public let priceRefMaxAgeNanos : Int = 600_000_000_000;

  // NAK a stranger may have sent a helper during a job that ICPSwap refunded: up to this
  // much is ignored (left in the deposit account) instead of blocking the refund.
  public let helperDustNak : Nat = 100_000_000_000; // 1,000 NAK

  // With nothing to swap, the price reference is refreshed every this many ticks (enough
  // to keep it under its 10-minute age limit), not every tick.
  public let idleSampleEvery : Nat = 4;

  // Privacy: Houdini order ids (the link back to the user's sending wallet) are forgotten
  // this long after an order completes or is refunded.
  public let forgetHoudiniAfterNanos : Int = 2_592_000_000_000_000; // 30 days
};
