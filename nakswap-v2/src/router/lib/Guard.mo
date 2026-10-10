// Cycle safeguards. Below `lowCycles` the router stops taking new orders and stops
// starting new swaps (ICP that arrives just waits in its deposit account). Payouts and
// refunds for swaps already done keep running until `criticalCycles`, so nobody is left
// with funds mid-flight. The canister's freezing threshold (set to ~90 days of idle
// burn) is the last line: the IC freezes it with its state intact instead of deleting it.
module {
  public let lowCycles : Nat = 500_000_000_000; // 0.5T
  public let criticalCycles : Nat = 150_000_000_000; // 0.15T
};
