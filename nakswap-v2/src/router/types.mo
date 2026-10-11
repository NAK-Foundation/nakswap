import Map "mo:core/Map";
import Set "mo:core/Set";

module {

  public type Config = {
    admin : Principal;
    // Relay identities allowed to open orders (the relay holds the Houdini key).
    operators : [Principal];
    icpLedger : Principal;
    nakLedger : Principal;
    // ICPSwap NAK/ICP pool. Mainnet: d6hdt-qiaaa-aaaag-qm76q-cai (token0 = NAK, token1 = ICP).
    pool : Principal;
    icpIsToken0 : Bool;
    icpFee : Nat; // e8s, 10_000 on mainnet
    nakFee : Nat; // NAK ledger transfer fee in base units
    slippageBps : Nat; // tolerance vs the pool quote taken right before the swap
    maxImpactBps : Nat; // deposits that would move the price more than this are refunded as ICP
    minOrderIcp : Nat; // e8s
    maxOrderIcp : Nat; // e8s
    orderTtlSeconds : Nat; // how long to wait for Houdini to deliver ICP
    paused : Bool;
  };

  public type RefundReason = {
    #tooSmall;
    #tooLarge;
    #priceImpact : { bps : Nat };
    #swapFailed : Text;
    #admin;
  };

  public type Status = {
    // Waiting for Houdini to pay ICP into this order's deposit account.
    #awaitingDeposit;
    // ICP swept out of the deposit account and handed to ICPSwap; outcome not recorded yet.
    #swapping : { icpIn : Nat; startedAt : Int };
    // Swap done; NAK sits in the router's main account waiting to be sent.
    #payoutPending : { icpIn : Nat; nakAmount : Nat; createdAtTime : Nat64 };
    // ICP is going back to the user's principal instead of being swapped.
    #refundPending : {
      icpAmount : Nat;
      fromDeposit : Bool; // true: from the order's subaccount; false: from the router's main account
      reason : RefundReason;
      createdAtTime : Nat64;
    };
    #completed : { icpIn : Nat; nakOut : Nat; block : Nat };
    #refunded : { icpAmount : Nat; reason : RefundReason; block : Nat };
    #expired;
    #needsReview : Text;
  };

  public type Order = {
    id : Nat;
    recipient : Principal; // receives NAK
    refundTo : Principal; // receives ICP if the swap cannot happen
    minNakOut : Nat; // 0 = no user floor beyond the slippage guard
    createdAt : Int;
    subaccount : Blob;
    depositAccountId : Blob; // 32-byte ICP account identifier Houdini pays to
    var houdiniId : ?Text;
    var status : Status;
    var lastCheckedAt : Int;
  };

  public type OrderView = {
    id : Nat;
    recipient : Principal;
    refundTo : Principal;
    minNakOut : Nat;
    createdAt : Int;
    depositAccountId : Text; // hex, what goes into Houdini's addressTo
    depositSubaccount : Blob;
    houdiniId : ?Text;
    status : Status;
  };

  public type CreateOrderArgs = {
    recipient : Principal;
    refundTo : ?Principal;
    minNakOut : ?Nat;
  };

  public type CreateOrderError = {
    #notAuthorized;
    #paused;
    #anonymousRecipient;
    #invalidRecipient;
    #tooManyOpenOrders;
  };

  public type PokeResult = {
    #processed : Status;
    #busy;
    #tooSoon;
    #notFound;
    #notAuthorized;
  };

  public type Health = {
    cycles : Nat;
    lowCyclesThreshold : Nat;
    acceptingOrders : Bool;
    paused : Bool;
    activeOrders : Nat;
    nextOrderId : Nat;
    feeBps : Nat;
    helpers : Nat;
  };

  // NAKSwap fee: a share of the ICP each *completed* swap brings in, kept in the router's
  // main account (`accrued`) and swept to `to`. Refunded orders pay no fee.
  public type FeeSweep = { gross : Nat; amount : Nat; to : Principal; createdAtTime : Nat64 };

  public type FeeState = {
    var bps : Nat;
    var to : Principal;
    var accrued : Nat; // e8s held in main that belong to the fee wallet
    var paidTotal : Nat; // e8s delivered to fee wallets so far
    var stuck : Nat; // e8s whose sweep outcome is unknown (verify on the ledger)
    var pending : ?FeeSweep;
  };

  // Random secret behind the deposit subaccounts, plus the cursor of the background pass
  // that forgets old Houdini order ids.
  public type PrivacyState = {
    var secret : Blob;
    var redactCursor : Nat;
  };

  // Swap helpers (added with the helper upgrade). Each helper canister runs one ICPSwap swap at
  // a time from its own account and returns the results to the order's deposit account.
  public type ExecState = { var helpers : [Principal] };

  // The NAKSwap fee of a helper-path order sits in that order's deposit account until it is
  // sent to the fee wallet; created_at_time is fixed so a retry is deduplicated.
  public type SubFee = { amount : Nat; to : Principal; createdAtTime : Nat64 };

  // Per-run bookkeeping handed to the engine. The Map/Set inside point at stable state;
  // inFlight / busyHelpers are transient (nothing is in flight across an upgrade, which is
  // done with the canister stopped).
  public type Runtime = {
    exec : ExecState;
    payFromSub : Set.Set<Nat>; // payouts paid from the order's own deposit account
    subFees : Map.Map<Nat, SubFee>;
    inFlight : Set.Set<Nat>; // orders with a step running right now
    busyHelpers : Set.Set<Principal>;
    quarantined : Set.Set<Principal>; // helpers that may hold someone's funds; admin clears
    helperOrders : Map.Map<Principal, Nat>; // quarantined helper -> the order whose funds it holds
    jobFees : Map.Map<Nat, Nat>; // order -> its 1% fee, while its funds are with a helper
    // Expired orders still watched for a late deposit: order -> next check time (ns).
    lateWatch : Map.Map<Nat, Int>;
    stats : Stats;
    priceRef : PriceRef; // transient: rebuilt from live samples after an upgrade
    revived : Set.Set<Nat>; // finished orders the late-deposit watch reopened
    dustPayout : DustPayout;
    var nextHelper : Nat;
  };

  // Admin dashboard: guardians (Internet Identity principals of the dashboard) can watch,
  // freeze/unfreeze and request audits; nothing that moves funds or changes settings.
  public type AuditRequest = { id : Nat; at : Int; by : Principal; note : Text };
  public type OpsState = {
    guardians : Set.Set<Principal>;
    audits : Map.Map<Nat, AuditRequest>;
    var nextAudit : Nat;
  };
  public type Role = { #controller; #admin; #guardian; #operator; #none };

  public type OrderLine = { id : Nat; status : Text; createdAt : Int; icpIn : Nat; nakOut : Nat; detail : Text };

  public type Overview = {
    health : Health;
    maxOpenOrders : Nat;
    counts : [(Text, Nat)];
    ordersLastHour : Nat;
    review : [OrderLine];
    recent : [OrderLine];
    helpers : [HelperInfo];
    fees : FeeStatus;
    ordersWithHelperFunds : Nat;
    straySubaccount : Blob;
  };

  public type HelperInfo = { helper : Principal; busy : Bool; quarantined : Bool; holdsOrder : ?Nat };

  public type FeeStatus = {
    bps : Nat;
    to : Principal;
    accrued : Nat;
    paidTotal : Nat;
    stuck : Nat;
    pending : ?FeeSweep;
    autoSweepAt : Nat;
  };

  // Where the stray account (dust swept from deposit accounts, tokens strangers sent to
  // helpers) is paid out automatically, once it holds at least `minIcp`.
  public type DustPayout = { var to : ?Principal; var minIcp : Nat };
  public type DustPayoutInfo = { to : ?Principal; minIcp : Nat };

  // Slow moving average of the pool's marginal price (NAK out for the 0.01 ICP probe).
  public type PriceRef = { var probe : Nat; var at : Int };

  // Running totals of completed swaps, for the public stats strip (no per-call scan).
  public type Stats = { var swaps : Nat; var icpSwapped : Nat; var nakDelivered : Nat; var ready : Bool };

  public type RouterState = {
    var config : Config;
    var nextId : Nat;
    var busy : Bool;
  };
};
