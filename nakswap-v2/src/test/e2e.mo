// End-to-end run of the NAKSwap v2 router against mock ledgers and a mock ICPSwap pool.
// The test actor plays admin, relay (operator) and Houdini (pays ICP to the deposit
// account with a legacy account-id transfer, the way an exchange payout would).
// Run with the Motoko interpreter: the whole program is one actor system.
import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Char "mo:core/Char";
import Debug "mo:core/Debug";
import Int "mo:core/Int";
import Iter "mo:core/Iter";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import Account "../common/Account";
import MockLedger "../mocks/MockLedger";
import MockSwapPool "../mocks/MockSwapPool";
import RouterMod "../router/main";
import Types "../router/types";
import Stranger "Stranger";

actor Test {

  let ICP : Nat = 100_000_000; // e8s
  let NAK : Nat = 100_000_000; // NAK base units (8 decimals assumed)
  let icpFee : Nat = 10_000;
  let nakFee : Nat = 1_000_000; // mainnet NAK ledger fee (0.01 NAK)

  var failures = 0;

  func check(name : Text, ok : Bool) {
    if (ok) { Debug.print("  PASS " # name) } else {
      failures += 1;
      Debug.print("  FAIL " # name);
    };
  };

  func hexToBlob(h : Text) : Blob {
    let cs = h.chars().toArray();
    func v(c : Char) : Nat {
      let n = c.toNat32().toNat();
      if (n >= 97) { n - 87 } else { n - 48 };
    };
    Array.tabulate<Nat8>(cs.size() / 2, func i = (v(cs[2 * i]) * 16 + v(cs[2 * i + 1])).toNat8()).toBlob();
  };

  func statusTag(s : Types.Status) : Text {
    switch s {
      case (#awaitingDeposit) { "awaitingDeposit" };
      case (#swapping _) { "swapping" };
      case (#payoutPending _) { "payoutPending" };
      case (#refundPending _) { "refundPending" };
      case (#completed _) { "completed" };
      case (#refunded _) { "refunded" };
      case (#expired) { "expired" };
      case (#needsReview m) { "needsReview(" # m # ")" };
    };
  };

  public func run() : async () {
    let me = Principal.fromActor(Test);
    let user = Principal.fromText("2vxsx-fae"); // anonymous is rejected as recipient; checked below
    let alice = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai"); // any non-anonymous principal works as a recipient

    // ---- deploy ----
    let icp = await MockLedger.MockLedger("ICP", icpFee);
    let nak = await MockLedger.MockLedger("NAK", nakFee);
    let icpId = Principal.fromActor(icp);
    let nakId = Principal.fromActor(nak);
    // Mainnet layout: NAK is token0, ICP is token1 -> ICP->NAK is zeroForOne = false.
    let pool = await MockSwapPool.MockSwapPool(icpId, nakId, false);
    let poolId = Principal.fromActor(pool);
    // Reserves shaped like the live pool (~1466 ICP / ~162M NAK).
    ignore await nak.mint({ owner = poolId; subaccount = null }, 162_000_000 * NAK);
    ignore await icp.mint({ owner = poolId; subaccount = null }, 1_466 * ICP);
    await pool.seed(1_466 * ICP, 162_000_000 * NAK);

    let cfg : Types.Config = {
      admin = me;
      operators = [me];
      icpLedger = icpId;
      nakLedger = nakId;
      pool = poolId;
      icpIsToken0 = false;
      icpFee;
      nakFee;
      slippageBps = 100;
      maxImpactBps = 500;
      minOrderIcp = ICP / 10;
      maxOrderIcp = 50 * ICP;
      orderTtlSeconds = 7_200;
      paused = false;
    };
    let router = await RouterMod.Router(cfg, 0);
    let routerId = Principal.fromActor(router);

    // Houdini's hot wallet.
    ignore await icp.mint({ owner = me; subaccount = null }, 1_000 * ICP);

    func houdiniPays(depositHex : Text, amount : Nat) : async () {
      switch (
        await icp.transfer({
          memo = 0;
          amount = { e8s = amount.toNat64() };
          fee = { e8s = icpFee.toNat64() };
          from_subaccount = null;
          to = hexToBlob(depositHex);
          created_at_time = null;
        })
      ) {
        case (#Ok _) {};
        case (#Err _) { Runtime.trap("houdini payout failed") };
      };
    };

    func newOrder(recipient : Principal, minNakOut : ?Nat) : async Types.OrderView {
      switch (await router.createOrder({ recipient; refundTo = null; minNakOut })) {
        case (#ok v) { v };
        case (#err _) { Runtime.trap("createOrder failed") };
      };
    };

    func statusOf(id : Nat) : async Types.Status {
      switch (await router.getOrder(id)) {
        case (?v) { v.status };
        case null { Runtime.trap("no order") };
      };
    };

    func pokeUntilSettled(id : Nat) : async Types.Status {
      var i = 0;
      while (i < 5) {
        ignore await router.poke(id);
        let s = await statusOf(id);
        switch s {
          case (#awaitingDeposit or #payoutPending _ or #refundPending _) {};
          case _ { return s };
        };
        i += 1;
      };
      await statusOf(id);
    };

    let routerMain = { owner = routerId; subaccount = null };

    // ---- 0. deposit account id matches the ledger's own derivation ----
    Debug.print("0. deposit account");
    let o0 = await newOrder(alice, null);
    let ledgerView = await icp.accountIdHex({ owner = routerId; subaccount = ?Account.orderSubaccount(o0.id) });
    check("router and ledger agree on account id", ledgerView == o0.depositAccountId);
    check("account id is 64 hex chars", o0.depositAccountId.size() == 64);
    Debug.print("  VECTOR router=" # routerId.toText() # " sub=" # Account.toHex(Account.orderSubaccount(o0.id)) # " aid=" # o0.depositAccountId);

    // ---- 1. happy path ----
    Debug.print("1. happy path: 5 ICP -> NAK to alice");
    await houdiniPays(o0.depositAccountId, 5 * ICP);
    let fee1 = 5 * ICP / 100; // NAKSwap fee, 1% default
    let quoted = switch (await pool.quote({ amountIn = (5 * ICP - 3 * icpFee - fee1).toText(); zeroForOne = false; amountOutMinimum = "0" })) {
      case (#ok q) { q };
      case (#err _) { 0 };
    };
    let s1 = await pokeUntilSettled(o0.id);
    check("status completed (got " # statusTag(s1) # ")", statusTag(s1) == "completed");
    let aliceNak = await nak.icrc1_balance_of({ owner = alice; subaccount = null });
    // pool withdraw fee + router payout fee
    check("alice got quote minus two NAK fees (" # aliceNak.toText() # " vs quote " # quoted.toText() # ")", aliceNak == quoted - 2 * nakFee);
    check("deposit subaccount drained", (await icp.icrc1_balance_of({ owner = routerId; subaccount = ?Account.orderSubaccount(o0.id) })) == 0);
    check("router main holds exactly the 1% fee", (await icp.icrc1_balance_of(routerMain)) == fee1);
    check("router main holds no NAK", (await nak.icrc1_balance_of(routerMain)) == 0);
    let fs1 = await router.feeStatus();
    check("fee accrued = 1% of 5 ICP (" # fs1.accrued.toText() # ")", fs1.accrued == fee1 and fs1.bps == 100 and fs1.to == me);

    // ---- 1b. fee sweep to the fee wallet ----
    Debug.print("1b. fee sweep");
    let feeWallet = Principal.fromText("qoctq-giaaa-aaaaa-aaaea-cai");
    check("admin can set the fee wallet", await router.setFee(100, feeWallet));
    check("fee above 5% rejected", not (await router.setFee(600, feeWallet)));
    let swept = await router.sweepFees();
    check("swept fee minus one ledger fee (" # swept.toText() # ")", swept == fee1 - icpFee);
    check("fee wallet received it", (await icp.icrc1_balance_of({ owner = feeWallet; subaccount = null })) == fee1 - icpFee);
    check("router main holds no ICP after sweep", (await icp.icrc1_balance_of(routerMain)) == 0);
    let fs1b = await router.feeStatus();
    check("accrued reset, paidTotal recorded", fs1b.accrued == 0 and fs1b.paidTotal == fee1 - icpFee and fs1b.pending == null);
    check("nothing to sweep now", (await router.sweepFees()) == 0);

    // ---- 2. slippage: user floor above what the pool gives -> ICP refund ----
    Debug.print("2. slippage guard refunds ICP");
    let bob = Principal.fromText("mxzaz-hqaaa-aaaar-qaada-cai");
    let o2 = await newOrder(bob, ?(1_000_000_000 * NAK));
    await houdiniPays(o2.depositAccountId, 2 * ICP);
    let s2 = await pokeUntilSettled(o2.id);
    check("status refunded (got " # statusTag(s2) # ")", statusTag(s2) == "refunded");
    let bobIcp = await icp.icrc1_balance_of({ owner = bob; subaccount = null });
    // 2 ICP minus: sweep, approve, transfer_from, pool refund transfer, router refund transfer
    check("bob got ICP back minus 5 fees (" # bobIcp.toText() # ")", bobIcp == 2 * ICP - 5 * icpFee);
    check("bob got no NAK", (await nak.icrc1_balance_of({ owner = bob; subaccount = null })) == 0);
    check("no fee taken on a refunded swap", (await router.feeStatus()).accrued == 0 and (await icp.icrc1_balance_of(routerMain)) == 0);

    // ---- 3. above maxOrderIcp -> refunded straight from the deposit account ----
    Debug.print("3. oversize deposit");
    let carol = Principal.fromText("mqygn-kiaaa-aaaar-qaadq-cai");
    let o3 = await newOrder(carol, null);
    await houdiniPays(o3.depositAccountId, 60 * ICP);
    let s3 = await pokeUntilSettled(o3.id);
    check("status refunded (got " # statusTag(s3) # ")", statusTag(s3) == "refunded");
    check("carol got 60 ICP minus one fee", (await icp.icrc1_balance_of({ owner = carol; subaccount = null })) == 60 * ICP - icpFee);

    // ---- 4. price impact guard ----
    Debug.print("4. price impact guard");
    ignore await router.setConfig({ cfg with maxImpactBps = 100 });
    let dave = Principal.fromText("ss2fx-dyaaa-aaaar-qacoq-cai");
    let o4 = await newOrder(dave, null);
    await houdiniPays(o4.depositAccountId, 40 * ICP);
    ignore await router.poke(o4.id);
    let s4a = await statusOf(o4.id);
    let impactOk = switch s4a {
      case (#refundPending { reason = #priceImpact { bps }; fromDeposit = true }) { bps > 100 };
      case _ { false };
    };
    check("refund queued for price impact (got " # statusTag(s4a) # ")", impactOk);
    let s4 = await pokeUntilSettled(o4.id);
    check("then refunded", statusTag(s4) == "refunded");
    ignore await router.setConfig(cfg);

    // ---- 5. payout retry after a ledger hiccup ----
    Debug.print("5. payout retry");
    let erin = Principal.fromText("xevnm-gaaaa-aaaar-qafnq-cai");
    let o5 = await newOrder(erin, null);
    await houdiniPays(o5.depositAccountId, 1 * ICP);
    ignore await router.poke(o5.id); // swap -> payoutPending
    check("payout pending after swap", statusTag(await statusOf(o5.id)) == "payoutPending");
    await nak.setFailTransfers(1);
    ignore await router.poke(o5.id); // payout fails
    check("still payoutPending after failed transfer", statusTag(await statusOf(o5.id)) == "payoutPending");
    ignore await router.poke(o5.id); // payout succeeds
    check("completed on retry", statusTag(await statusOf(o5.id)) == "completed");
    let erinNak = await nak.icrc1_balance_of({ owner = erin; subaccount = null });
    check("erin paid exactly once (" # erinNak.toText() # ")", erinNak > 0 and (await nak.icrc1_balance_of(routerMain)) == 0);

    // ---- 6. pool withdraw failure is parked for review, not lost ----
    Debug.print("6. pool failure -> needsReview");
    let o6 = await newOrder(alice, null);
    await houdiniPays(o6.depositAccountId, 1 * ICP);
    await pool.setBreakNextSwap(true);
    let s6 = await pokeUntilSettled(o6.id);
    check("needsReview (got " # statusTag(s6) # ")", statusTag(s6).startsWith(#text "needsReview"));

    // ---- 7. expiry: nothing paid within the TTL ----
    Debug.print("7. expiry");
    ignore await router.setConfig({ cfg with orderTtlSeconds = 0 });
    let o7 = await newOrder(alice, null);
    ignore await router.attachHoudini(o7.id, "houdini-o7");
    ignore await router.poke(o7.id);
    check("expired", statusTag(await statusOf(o7.id)) == "expired");
    let o7b = await newOrder(alice, null); // never paired with a Houdini exchange
    check("unpaired order is deleted, not kept", (await router.poke(o7b.id)) == #notFound and (await router.getOrder(o7b.id)) == null);
    check("reopen works", (await router.reopen(o7.id)) == ?#awaitingDeposit);
    ignore await router.setConfig(cfg);

    // ---- 8. access control ----
    Debug.print("8. access control");
    let stranger = await Stranger.Stranger();
    check("stranger cannot open orders", not (await stranger.tryCreate(routerId, alice)));
    check("stranger cannot change the fee", not (await stranger.trySetFee(routerId, alice)));
    check("stranger cannot sweep fees", (await stranger.trySweep(routerId)) == 0);
    check("fee unchanged", (await router.feeStatus()).to == feeWallet);
    let anonRes = await router.createOrder({ recipient = user; refundTo = null; minNakOut = null });
    check("anonymous recipient rejected", switch anonRes { case (#err(#anonymousRecipient)) { true }; case _ { false } });

    // ---- 9. hardening ----
    Debug.print("9. hardening");
    let o9 = await newOrder(alice, null);
    check("stranger cannot poke", (await stranger.tryPoke(routerId, o9.id)) == #notAuthorized);
    check("stranger cannot read orders", (await stranger.tryGetOrder(routerId, o9.id)) == null);
    check("houdini id attaches once", await router.attachHoudini(o9.id, "h-1"));
    check("houdini id cannot be re-pointed", not (await router.attachHoudini(o9.id, "h-2")));
    check("houdini id attach is idempotent", await router.attachHoudini(o9.id, "h-1"));
    check("oversized houdini id rejected", not (await router.attachHoudini(o0.id, "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")));
    let selfRes = await router.createOrder({ recipient = routerId; refundTo = null; minNakOut = null });
    check("router itself rejected as recipient", switch selfRes { case (#err(#invalidRecipient)) { true }; case _ { false } });
    check("setConfig cannot swap the pool", not (await router.setConfig({ cfg with pool = alice })));
    check("setConfig rejects 50% slippage", not (await router.setConfig({ cfg with slippageBps = 5_000 })));
    check("setConfig rejects min >= max", not (await router.setConfig({ cfg with minOrderIcp = 60 * ICP })));
    check("setConfig accepts sane values", await router.setConfig({ cfg with maxOrderIcp = 30 * ICP }));
    check("config kept the pool", (await router.getConfig()).pool == poolId);
    var opened = 0;
    var capped = false;
    label spam while (opened < 200) {
      switch (await router.createOrder({ recipient = alice; refundTo = null; minNakOut = null })) {
        case (#ok _) { opened += 1 };
        case (#err(#tooManyOpenOrders)) { capped := true; break spam };
        case (#err _) { break spam };
      };
    };
    check("open orders capped at 150 (opened " # opened.toText() # " more)", capped and (await router.activeOrderIds()).size() == 150);

    Debug.print(if (failures == 0) { "ALL PASSED" } else { failures.toText() # " FAILED" });
  };
};

Test.run();
