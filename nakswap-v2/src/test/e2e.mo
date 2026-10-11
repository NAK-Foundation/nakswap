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
import HelperMod "../helper/main";
import RouterMod "../router/main";
import Types "../router/types";
import Engine "../router/lib/Engine";
import Time "mo:core/Time";
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
    let ledgerView = await icp.accountIdHex({ owner = routerId; subaccount = ?o0.depositSubaccount });
    check("router and ledger agree on account id", ledgerView == o0.depositAccountId);
    check("deposit subaccount is not the guessable order-number pattern", o0.depositSubaccount != Account.orderSubaccount(o0.id));
    let o0b = await newOrder(alice, null);
    check("deposit subaccounts differ per order", o0b.depositSubaccount != o0.depositSubaccount and o0b.depositSubaccount.size() == 32);
    check("account id is 64 hex chars", o0.depositAccountId.size() == 64);
    Debug.print("  VECTOR router=" # routerId.toText() # " sub=" # Account.toHex(o0.depositSubaccount) # " aid=" # o0.depositAccountId);

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
    check("deposit subaccount drained", (await icp.icrc1_balance_of({ owner = routerId; subaccount = ?o0.depositSubaccount })) == 0);
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

    // ---- 6b. ICPSwap's payout failed on its side; once it's retried the admin pays the user ----
    Debug.print("6b. recover a failed ICPSwap payout");
    let accrued6 = (await router.feeStatus()).accrued;
    let mainIcp6 = await icp.icrc1_balance_of(routerMain);
    check("forceRefund above what main can spare is refused", statusTag((await router.forceRefund(o6.id, mainIcp6 - accrued6, false)) ?? #expired).startsWith(#text "needsReview"));
    check("forceRefund from an empty deposit is refused", statusTag((await router.forceRefund(o6.id, ICP / 2, true)) ?? #expired).startsWith(#text "needsReview"));
    await pool.retryFailed(); // ICPSwap's admin re-sends the stuck payout
    let mainNak6 = await nak.icrc1_balance_of(routerMain);
    check("the NAK reached the router (" # mainNak6.toText() # ")", mainNak6 > nakFee);
    let aliceNak6 = await nak.icrc1_balance_of({ owner = alice; subaccount = null });
    check("forcePayout accepted", statusTag((await router.forcePayout(o6.id, mainNak6 - nakFee, false)) ?? #expired) == "payoutPending");
    check("then completed", statusTag(await pokeUntilSettled(o6.id)) == "completed");
    check("alice got it", (await nak.icrc1_balance_of({ owner = alice; subaccount = null })) == aliceNak6 + mainNak6 - nakFee);

    // ---- 6c. extra NAK lands mid-swap: flagged, not paid to the wrong person ----
    Debug.print("6c. unexplained balance change");
    let o6c = await newOrder(bob, null);
    await houdiniPays(o6c.depositAccountId, ICP);
    await pool.setBonusNextSwap(500_000 * NAK);
    let s6c = await pokeUntilSettled(o6c.id);
    check("needsReview instead of paying the extra (got " # statusTag(s6c) # ")", statusTag(s6c).startsWith(#text "needsReview(balances moved"));
    let mainNak = await nak.icrc1_balance_of(routerMain);
    check("forcePayout above main's NAK is refused", statusTag((await router.forcePayout(o6c.id, mainNak, false)) ?? #expired).startsWith(#text "needsReview"));
    let bobNak0 = await nak.icrc1_balance_of({ owner = bob; subaccount = null });
    let owed = mainNak - 500_000 * NAK - nakFee : Nat;
    check("forcePayout of the order's share accepted", statusTag((await router.forcePayout(o6c.id, owed, false)) ?? #expired) == "payoutPending");
    check("then completed", statusTag(await pokeUntilSettled(o6c.id)) == "completed");
    check("bob got exactly his share", (await nak.icrc1_balance_of({ owner = bob; subaccount = null })) == bobNak0 + owed);

    // ---- 7. expiry: nothing paid within the TTL ----
    Debug.print("7. expiry");
    ignore await router.setConfig({ cfg with orderTtlSeconds = 0 });
    let o7 = await newOrder(alice, null);
    ignore await router.attachHoudini(o7.id, "houdini-o7");
    ignore await router.poke(o7.id);
    check("expired", statusTag(await statusOf(o7.id)) == "expired");
    let o7b = await newOrder(alice, null); // never paired with a Houdini exchange
    check("unpaired order is deleted, not kept", (await router.poke(o7b.id)) == #notFound and (await router.getOrder(o7b.id)) == null);
    // Someone pays into the deleted order's account anyway: the admin can still get it back.
    await houdiniPays(o7b.depositAccountId, ICP);
    let frank = Principal.fromText("ufxgi-4p777-77774-qaadq-cai");
    let rec = await router.recoverDeposit(o7b.id, frank);
    check("stray deposit recovered (" # debug_show rec # ")", rec == #ok({ icp = ICP - icpFee; nak = 0 }) and (await icp.icrc1_balance_of({ owner = frank; subaccount = null })) == ICP - icpFee);
    check("recover refuses unknown order ids", switch (await router.recoverDeposit(o7.id + 100, frank)) { case (#err _) { true }; case _ { false } });
    // 7b. late deposit: a direct-ICP order paid after its window is revived and swapped.
    // Finished orders are watched too, so count relative to what's watched already.
    let w0 = (await router.publicStats()).lateWatched;
    let lucy = Principal.fromBlob("\0A\10");
    let o7c = await newOrder(lucy, null);
    check("direct ICP order marked", await router.attachHoudini(o7c.id, "icp-direct"));
    ignore await router.poke(o7c.id);
    check("direct order expired", statusTag(await statusOf(o7c.id)) == "expired");
    check("expired orders are watched for late deposits", (await router.publicStats()).lateWatched == w0 + 1);
    ignore await router.checkLateDeposits();
    check("nothing arrived: stays expired", statusTag(await statusOf(o7c.id)) == "expired");
    await houdiniPays(o7c.depositAccountId, 15_000); // dust, less than a refund would cost
    ignore await router.checkLateDeposits();
    check("dust doesn't revive an order", statusTag(await statusOf(o7c.id)) == "expired");
    await houdiniPays(o7c.depositAccountId, 60_000); // 0.00075 ICP in all: above 2 fees, still dust
    ignore await router.checkLateDeposits();
    check("dust above two fees doesn't revive it either", statusTag(await statusOf(o7c.id)) == "expired");
    check("stranger can't trigger late checks", (await (await Stranger.Stranger()).tryLate(routerId)) == 0);
    await houdiniPays(o7c.depositAccountId, ICP);
    ignore await router.checkLateDeposits();
    check("late ICP revives the order", statusTag(await statusOf(o7c.id)) == "awaitingDeposit");
    check("and it is swapped (got " # statusTag(await pokeUntilSettled(o7c.id)) # ")", statusTag(await statusOf(o7c.id)) == "completed");
    check("lucy got her NAK", (await nak.icrc1_balance_of({ owner = lucy; subaccount = null })) > 0);
    check("revived order left the watch, then rejoined it once completed", (await router.publicStats()).lateWatched == w0 + 1);
    check("reopen works", (await router.reopen(o7.id)) == ?#awaitingDeposit);
    ignore await router.checkLateDeposits();
    check("reopened order dropped from the watch", (await router.publicStats()).lateWatched == w0);
    // Every watched order gets its turn: 15 expired orders, only the last one is paid; checks
    // take the most overdue first, so the second pass reaches it.
    var lastLate = o7c;
    for (k in Nat.range(0, 15)) {
      let o = await newOrder(Principal.fromBlob("\0A\11"), null);
      ignore await router.attachHoudini(o.id, "icp-direct");
      ignore await router.poke(o.id);
      lastLate := o;
    };
    check("15 expired orders watched", (await router.publicStats()).lateWatched == w0 + 15);
    await houdiniPays(lastLate.depositAccountId, ICP);
    ignore await router.checkLateDeposits();
    ignore await router.checkLateDeposits();
    check("the newest one isn't starved (" # statusTag(await statusOf(lastLate.id)) # ")", statusTag(await statusOf(lastLate.id)) == "awaitingDeposit");
    check("and only it left the watch", (await router.publicStats()).lateWatched == w0 + 14);
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

    // ---- 10. swap helpers: parallel swaps, each settled in its own deposit account ----
    Debug.print("10. swap helpers");
    let h0 = await HelperMod.Helper(routerId, icpId, nakId, poolId, false);
    let h1 = await HelperMod.Helper(routerId, icpId, nakId, poolId, false);
    let h2 = await HelperMod.Helper(routerId, icpId, nakId, poolId, false);
    let hIds = [Principal.fromActor(h0), Principal.fromActor(h1), Principal.fromActor(h2)];
    check("setHelpers rejects duplicates", not (await router.setHelpers([hIds[0], hIds[0]], "")));
    check("setHelpers rejects the router itself", not (await router.setHelpers([routerId], "")));
    check("setHelpers accepts three helpers", await router.setHelpers(hIds, ""));
    check("strangers can't use a helper", (await stranger.trySwap(hIds[0])) == #notAuthorized);
    ignore await router.sweepFees(); // start from a clean fee state
    let feeWalletBefore = await icp.icrc1_balance_of({ owner = feeWallet; subaccount = null });

    let mainNakBefore = await nak.icrc1_balance_of(routerMain);
    let mainIcpBefore = await icp.icrc1_balance_of(routerMain);

    // 10a. one swap through a helper
    let gina = Principal.fromBlob("\0A\01");
    let o10 = await newOrder(gina, null);
    await houdiniPays(o10.depositAccountId, 5 * ICP);
    let in10 = 5 * ICP - 4 * icpFee - 5 * ICP / 100;
    let q10 = switch (await pool.quote({ amountIn = in10.toText(); zeroForOne = false; amountOutMinimum = "0" })) { case (#ok q) { q }; case (#err _) { 0 } };
    let s10 = await pokeUntilSettled(o10.id);
    check("helper swap completed (got " # statusTag(s10) # ")", statusTag(s10) == "completed");
    let ginaNak = await nak.icrc1_balance_of({ owner = gina; subaccount = null });
    check("gina got quote minus three NAK fees (" # ginaNak.toText() # " vs " # q10.toText() # ")", ginaNak == q10 - 3 * nakFee);
    check("router main untouched by the helper path", (await nak.icrc1_balance_of(routerMain)) == mainNakBefore and (await icp.icrc1_balance_of(routerMain)) == mainIcpBefore);
    check("the 1% fee waits in gina's deposit account", (await icp.icrc1_balance_of({ owner = routerId; subaccount = ?o10.depositSubaccount })) == 5 * ICP / 100);
    var helpersEmpty = true;
    for (h in hIds.values()) {
      if ((await icp.icrc1_balance_of({ owner = h; subaccount = null })) > 0 or (await nak.icrc1_balance_of({ owner = h; subaccount = null })) > 0) { helpersEmpty := false };
    };
    check("helpers keep nothing", helpersEmpty);

    // 10b. three swaps at the same time
    let r1 = Principal.fromBlob("\0A\02");
    let r2 = Principal.fromBlob("\0A\03");
    let r3 = Principal.fromBlob("\0A\04");
    let p1 = await newOrder(r1, null);
    let p2 = await newOrder(r2, null);
    let p3 = await newOrder(r3, null);
    await houdiniPays(p1.depositAccountId, 1 * ICP);
    await houdiniPays(p2.depositAccountId, 2 * ICP);
    await houdiniPays(p3.depositAccountId, 3 * ICP);
    let f1 = router.poke(p1.id);
    let f2 = router.poke(p2.id);
    let f3 = router.poke(p3.id);
    let (a1, a2, a3) = (await f1, await f2, await f3);
    func tagOf(r : Types.PokeResult) : Text { switch r { case (#processed s) { statusTag(s) }; case (#busy) { "busy" }; case _ { "other" } } };
    // On the old single-lock path two of these would have answered "busy".
    check("all three swapped at the same time (" # tagOf(a1) # ", " # tagOf(a2) # ", " # tagOf(a3) # ")",
      tagOf(a1) == "payoutPending" and tagOf(a2) == "payoutPending" and tagOf(a3) == "payoutPending");
    ignore await pokeUntilSettled(p1.id);
    ignore await pokeUntilSettled(p2.id);
    ignore await pokeUntilSettled(p3.id);
    let n1 = await nak.icrc1_balance_of({ owner = r1; subaccount = null });
    let n2 = await nak.icrc1_balance_of({ owner = r2; subaccount = null });
    let n3 = await nak.icrc1_balance_of({ owner = r3; subaccount = null });
    check("each got their own NAK (" # n1.toText() # " < " # n2.toText() # " < " # n3.toText() # ")", n1 > 0 and n1 < n2 and n2 < n3);
    check("payout matches each order's own completion record", switch (await statusOf(p2.id)) { case (#completed c) { c.nakOut == n2 }; case _ { false } });
    check("no helper left busy", (await router.helpers()).all(func(i : Types.HelperInfo) : Bool = not i.busy));

    // 10c. slippage on the helper path: everything comes back from the deposit account
    let hank = Principal.fromBlob("\0A\05");
    let o10c = await newOrder(hank, ?(1_000_000_000 * NAK));
    await houdiniPays(o10c.depositAccountId, 2 * ICP);
    let s10c = await pokeUntilSettled(o10c.id);
    check("refunded (got " # statusTag(s10c) # ")", statusTag(s10c) == "refunded");
    check("hank got 2 ICP minus 7 ledger fees", (await icp.icrc1_balance_of({ owner = hank; subaccount = null })) == 2 * ICP - 7 * icpFee);

    // 10d. ICPSwap's payout fails: the helper keeps it, is quarantined, admin recovers it
    let ivy = Principal.fromBlob("\0A\06");
    let o10d = await newOrder(ivy, null);
    await houdiniPays(o10d.depositAccountId, ICP);
    await pool.setBreakNextSwap(true);
    let s10d = await pokeUntilSettled(o10d.id);
    check("needsReview while ICPSwap hasn't paid (got " # statusTag(s10d) # ")", statusTag(s10d).startsWith(#text "needsReview(helper"));
    let infos = await router.helpers();
    var which = 99;
    var hi = 0;
    for (info in infos.values()) { if (info.holdsOrder == ?o10d.id) { which := hi }; hi += 1 };
    check("that helper is quarantined and linked to the order", which < 3 and infos[which].quarantined);
    // Another order still goes through the other helpers meanwhile.
    let liz = Principal.fromBlob("\0A\09");
    let o10x = await newOrder(liz, null);
    await houdiniPays(o10x.depositAccountId, ICP);
    check("other helpers keep working", statusTag(await pokeUntilSettled(o10x.id)) == "completed");
    check("recover refused while ICPSwap is still pending", switch (await router.helperRecover(which, ?o10d.id)) { case (#err _) { true }; case _ { false } });
    check("clear refused while ICPSwap is still pending", not (await router.clearHelper(which)));
    await router.runRecovery();
    check("background recovery waits too", statusTag(await statusOf(o10d.id)).startsWith(#text "needsReview"));
    await pool.retryFailed(); // ICPSwap's admin re-sends the stuck payout
    await router.runRecovery(); // what the worker does on its next tick
    check("order resumes by itself (got " # statusTag(await statusOf(o10d.id)) # ")", statusTag(await statusOf(o10d.id)) == "payoutPending");
    check("then completed", statusTag(await pokeUntilSettled(o10d.id)) == "completed");
    check("ivy got her NAK", (await nak.icrc1_balance_of({ owner = ivy; subaccount = null })) > 0);
    check("helper back in rotation, unlinked", (await router.helpers())[which].quarantined == false and (await router.helpers())[which].holdsOrder == null);
    check("no helper quarantined now", (await router.helpers()).all(func(i : Types.HelperInfo) : Bool = not i.quarantined));

    // 10e. fees in the deposit accounts are swept to the fee wallet
    // gina, the three parallel orders, liz, and ivy (recovered automatically, fee included).
    let feesExpected = (5 * ICP / 100 - icpFee) + (1 * ICP / 100 - icpFee) + (2 * ICP / 100 - icpFee) + (3 * ICP / 100 - icpFee) + 2 * (ICP / 100 - icpFee);
    let swept10 = await router.sweepFees();
    check("swept the six helper-path fees (" # swept10.toText() # " vs " # feesExpected.toText() # ")", swept10 == feesExpected);
    check("fee wallet received them", (await icp.icrc1_balance_of({ owner = feeWallet; subaccount = null })) == feeWalletBefore + feesExpected);
    check("nothing left to sweep", (await router.sweepFees()) == 0 and (await router.feeStatus()).accrued == 0);

    // 10f. strangers sending funds to helpers can't block them or mix into an order
    Debug.print("10f. stray funds in helpers");
    for (h in hIds.values()) { ignore await icp.mint({ owner = h; subaccount = null }, ICP / 10) };
    let jill = Principal.fromBlob("\0A\07");
    let o10f = await newOrder(jill, null);
    await houdiniPays(o10f.depositAccountId, ICP);
    let in10f = ICP - 4 * icpFee - ICP / 100;
    let q10f = switch (await pool.quote({ amountIn = in10f.toText(); zeroForOne = false; amountOutMinimum = "0" })) { case (#ok q) { q }; case (#err _) { 0 } };
    check("order completes through a helper", statusTag(await pokeUntilSettled(o10f.id)) == "completed");
    check("jill got exactly her own NAK", (await nak.icrc1_balance_of({ owner = jill; subaccount = null })) == q10f - 3 * nakFee);
    check("no helper quarantined", (await router.helpers()).all(func(i : Types.HelperInfo) : Bool = not i.quarantined));
    let strayAcct = { owner = routerId; subaccount = ?Account.straySubaccount };
    check("the stray ICP was set aside, not given to jill", (await icp.icrc1_balance_of(strayAcct)) == ICP / 10 - icpFee);
    let kim = Principal.fromBlob("\0A\08");
    check("admin recovers stray funds", (await router.recoverStray(kim)) == #ok({ icp = ICP / 10 - 2 * icpFee; nak = 0 }));
    check("main NAK untouched by helper orders", (await nak.icrc1_balance_of(routerMain)) == mainNakBefore);

    // ---- 11. audit 2026-10-10 scenarios ----
    Debug.print("11a. recovery waits until the helper is really empty");
    let va = Principal.fromBlob("\0B\01");
    let oa = await newOrder(va, null);
    await houdiniPays(oa.depositAccountId, 2 * ICP);
    await pool.setBreakNextSwap(true);
    ignore await pokeUntilSettled(oa.id);
    var wa = 99;
    var ia = 0;
    for (info in (await router.helpers()).values()) { if (info.holdsOrder == ?oa.id) { wa := ia }; ia += 1 };
    check("helper holds the order", wa < 3);
    await pool.retryFailed(); // ICPSwap pays the NAK to the helper
    await nak.setFailTransfers(1); // ...but the helper's NAK transfer back fails once
    await router.runRecovery();
    check("order stays in review, helper still linked (" # statusTag(await statusOf(oa.id)) # ")",
      statusTag(await statusOf(oa.id)).startsWith(#text "needsReview") and (await router.helpers())[wa].holdsOrder == ?oa.id);
    await router.runRecovery(); // the ledger works again
    check("then resolved to a payout (" # statusTag(await pokeUntilSettled(oa.id)) # ")", statusTag(await statusOf(oa.id)) == "completed");
    check("va got her NAK, not a fee-sized refund", (await nak.icrc1_balance_of({ owner = va; subaccount = null })) > 100_000 * NAK);
    check("helper back in rotation", not (await router.helpers())[wa].quarantined);

    Debug.print("11b. helpers knocked out by pool hiccups come back by themselves");
    let vb = Principal.fromBlob("\0B\02");
    let ob = await newOrder(vb, null);
    await houdiniPays(ob.depositAccountId, ICP);
    await pool.setFailTxQuery(true);
    ignore await router.poke(ob.id);
    ignore await router.poke(ob.id);
    ignore await router.poke(ob.id);
    await pool.setFailTxQuery(false);
    check("all three helpers out of rotation", (await router.helpers()).all(func(i : Types.HelperInfo) : Bool = i.quarantined));
    check("the order just waits (" # statusTag(await statusOf(ob.id)) # ")", statusTag(await statusOf(ob.id)) == "awaitingDeposit");
    let strayAcctB = { owner = routerId; subaccount = ?Account.straySubaccount };
    let strayBeforeB = await icp.icrc1_balance_of(strayAcctB);
    await router.runRecovery();
    // One helper still held 0.1 ICP a stranger sent it in 10f: unlinked, so it's a stranger's
    // and goes to the stray account; every helper comes back by itself.
    check("all helpers back in rotation by themselves", (await router.helpers()).all(func(i : Types.HelperInfo) : Bool = not i.quarantined));
    check("the stranger's 0.1 ICP went to the stray account", (await icp.icrc1_balance_of(strayAcctB)) > strayBeforeB);
    check("and the order completes (" # statusTag(await pokeUntilSettled(ob.id)) # ")", statusTag(await statusOf(ob.id)) == "completed");
    Debug.print("11c. a second payment to a finished order is swapped too");
    let vc = Principal.fromBlob("\0B\03");
    let oc = await newOrder(vc, null);
    ignore await router.attachHoudini(oc.id, "icp-direct");
    await houdiniPays(oc.depositAccountId, ICP / 20); // a 'test' transfer below the minimum
    check("test transfer refunded", statusTag(await pokeUntilSettled(oc.id)) == "refunded");
    check("below 0.1 ICP: no NAK bought, ICP back minus one ledger fee", (await nak.icrc1_balance_of({ owner = vc; subaccount = null })) == 0 and (await icp.icrc1_balance_of({ owner = vc; subaccount = null })) == ICP / 20 - icpFee);
    await houdiniPays(oc.depositAccountId, 2 * ICP); // the real payment
    ignore await router.checkLateDeposits();
    check("real payment picked up (" # statusTag(await statusOf(oc.id)) # ")", statusTag(await statusOf(oc.id)) == "awaitingDeposit");
    check("and swapped", statusTag(await pokeUntilSettled(oc.id)) == "completed" and (await nak.icrc1_balance_of({ owner = vc; subaccount = null })) > 0);
    ignore await router.sweepFees();
    ignore await router.checkLateDeposits();
    check("a completed order with only its swept fee isn't revived", statusTag(await statusOf(oc.id)) == "completed");

    Debug.print("11d. dust is not a deposit; reserved principals");
    let od = await newOrder(alice, null);
    await houdiniPays(od.depositAccountId, 15_000);
    ignore await router.poke(od.id);
    check("dust leaves the order waiting, not in review", statusTag(await statusOf(od.id)) == "awaitingDeposit");
    check("a helper can't be the recipient", switch (await router.createOrder({ recipient = hIds[1]; refundTo = null; minNakOut = null })) { case (#err(#invalidRecipient)) { true }; case _ { false } });
    check("the pool can't be the refund address", switch (await router.createOrder({ recipient = alice; refundTo = ?poolId; minNakOut = null })) { case (#err(#invalidRecipient)) { true }; case _ { false } });
    check("a ledger can't be the fee wallet", not (await router.setFee(100, nakId)));

    Debug.print("11f. admin force-payout keeps the fee; helpers holding real funds wait for the admin");
    let vf = Principal.fromBlob("\0B\06");
    let of = await newOrder(vf, null);
    await houdiniPays(of.depositAccountId, 2 * ICP);
    await pool.setBreakNextSwap(true);
    ignore await pokeUntilSettled(of.id);
    var wf = 99;
    var jf = 0;
    for (info in (await router.helpers()).values()) { if (info.holdsOrder == ?of.id) { wf := jf }; jf += 1 };
    check("helper holds the parked order", wf < 3);
    check("a linked helper's funds can't go to stray", switch (await router.helperRecover(wf, null)) { case (#err _) { true }; case _ { false } });
    check("force-payout refused while a helper holds the funds", statusTag((await router.forcePayout(of.id, NAK, true)) ?? #expired).startsWith(#text "needsReview"));
    await pool.retryFailed();
    check("admin returns the helper's funds to the order", switch (await router.helperRecover(wf, ?of.id)) { case (#ok _) { true }; case _ { false } });
    let nakInDeposit = await nak.icrc1_balance_of({ owner = routerId; subaccount = ?of.depositSubaccount });
    check("force-payout accepted", statusTag((await router.forcePayout(of.id, nakInDeposit - nakFee, true)) ?? #expired) == "payoutPending");
    check("paid out", statusTag(await pokeUntilSettled(of.id)) == "completed");
    let vfIcp = await icp.icrc1_balance_of({ owner = vf; subaccount = null });
    let feeWalletBeforeF = await icp.icrc1_balance_of({ owner = feeWallet; subaccount = null });
    ignore await router.sweepFees();
    ignore await router.checkLateDeposits();
    ignore await pokeUntilSettled(of.id);
    check("the fee went to the fee wallet", (await icp.icrc1_balance_of({ owner = feeWallet; subaccount = null })) > feeWalletBeforeF);
    check("and not back to the user", (await icp.icrc1_balance_of({ owner = vf; subaccount = null })) == vfIcp and statusTag(await statusOf(of.id)) == "completed");
    ignore await router.clearHelper(wf);
    // A quarantined helper with no order linked holds no order's funds: whatever is in it goes
    // to the stray account and it comes back into rotation, with no admin needed.
    let og = await newOrder(vf, null);
    await houdiniPays(og.depositAccountId, ICP);
    await pool.setFailTxQuery(true);
    ignore await router.poke(og.id);
    await pool.setFailTxQuery(false);
    var wg = 99;
    var jg = 0;
    for (info in (await router.helpers()).values()) { if (info.quarantined and info.holdsOrder == null) { wg := jg }; jg += 1 };
    check("one helper out, unlinked", wg < 3);
    ignore await icp.mint({ owner = hIds[wg]; subaccount = null }, ICP);
    let strayBeforeG = await icp.icrc1_balance_of(strayAcctB);
    await router.runRecovery();
    check("holding 1 ICP, unlinked: moved to the stray account", (await icp.icrc1_balance_of(strayAcctB)) == strayBeforeG + ICP - icpFee);
    check("and released by itself", not (await router.helpers())[wg].quarantined);
    check("and the waiting order completes", statusTag(await pokeUntilSettled(og.id)) == "completed");

    Debug.print("11g. tokens a stranger sends a helper mid-swap can't stall it");
    let vs = Principal.fromBlob("\0B\0A");
    let os = await newOrder(vs, null);
    await houdiniPays(os.depositAccountId, ICP);
    await pool.setStrayNextSwap(30_000, 0); // 0.0003 ICP arrives while the helper swaps
    let ss = await pokeUntilSettled(os.id);
    check("order completes (got " # statusTag(ss) # ")", statusTag(ss) == "completed");
    check("no helper out of rotation", (await router.helpers()).all(func(i : Types.HelperInfo) : Bool = not i.quarantined and i.holdsOrder == null));
    check("the user got NAK", (await nak.icrc1_balance_of({ owner = vs; subaccount = null })) > 0);
    // Stranger NAK: more than the quote + 2% can explain. The order is paid its own share.
    let vn = Principal.fromBlob("\0B\0B");
    let on = await newOrder(vn, null);
    await houdiniPays(on.depositAccountId, ICP);
    await pool.setStrayNextSwap(0, 50_000 * NAK);
    let sn = await pokeUntilSettled(on.id);
    check("order completes despite extra NAK (got " # statusTag(sn) # ")", statusTag(sn) == "completed");
    let nOut = switch sn { case (#completed c) { c.nakOut }; case _ { 0 } };
    let leftNak = await nak.icrc1_balance_of({ owner = routerId; subaccount = ?on.depositSubaccount });
    check("paid only its own share; the extra stays in the deposit account (" # nOut.toText() # " paid, " # leftNak.toText() # " left)", nOut > 0 and (await nak.icrc1_balance_of({ owner = vn; subaccount = null })) == nOut and leftNak > 40_000 * NAK);
    check("helpers all in rotation", (await router.helpers()).all(func(i : Types.HelperInfo) : Bool = not i.quarantined and i.holdsOrder == null));
    // Stranger NAK during a swap ICPSwap refunds: the refund still goes through.
    let vr = Principal.fromBlob("\0B\0C");
    let orr = await newOrder(vr, ?(1_000_000_000 * NAK));
    await houdiniPays(orr.depositAccountId, ICP);
    await pool.setStrayNextSwap(0, 500 * NAK);
    let sr = await pokeUntilSettled(orr.id);
    check("refunded despite NAK dust (got " # statusTag(sr) # ")", statusTag(sr) == "refunded");
    check("helpers all in rotation after the refund", (await router.helpers()).all(func(i : Types.HelperInfo) : Bool = not i.quarantined and i.holdsOrder == null));

    Debug.print("11h. late-deposit watch backs off as the order ages");
    let lcfg = await router.getConfig();
    func fakeOrder(created : Int) : Types.Order = {
      id = 0; recipient = vs; refundTo = vs; minNakOut = 0; createdAt = created; subaccount = ""; depositAccountId = "";
      var houdiniId = null; var status = #expired; var lastCheckedAt = 0;
    };
    let tnow = Time.now();
    let closedAgo = func(h : Int) : Int = tnow - lcfg.orderTtlSeconds * 1_000_000_000 - h * 3_600_000_000_000;
    check("10 min in the first 6 h", Engine.lateInterval(fakeOrder(closedAgo(1)), lcfg, tnow) == 600_000_000_000);
    check("hourly until 24 h", Engine.lateInterval(fakeOrder(closedAgo(12)), lcfg, tnow) == 3_600_000_000_000);
    check("every 6 h after that", Engine.lateInterval(fakeOrder(closedAgo(30)), lcfg, tnow) == 21_600_000_000_000);

    Debug.print("11e. price guard");
    let now = Time.now();
    let ref : Types.PriceRef = { var probe = 0; var at = 0 };
    check("no reference yet: allowed", Engine.priceSane(ref, 900, now));
    Engine.updatePriceRef(ref, 1_000, now);
    check("2% worse: allowed", Engine.priceSane(ref, 980, now));
    check("4% worse: waits", not Engine.priceSane(ref, 960, now));
    check("better price: allowed", Engine.priceSane(ref, 1_100, now));
    check("stale reference: waits for a fresh sample", not Engine.priceSane(ref, 1_000, now + 700_000_000_000));
    for (_ in Nat.range(0, 6)) { Engine.updatePriceRef(ref, 960, now) };
    check("a real move is followed within a few ticks", Engine.priceSane(ref, 960, now));

    // ---- 9. hardening ----
    Debug.print("9. hardening");
    let o9 = await newOrder(alice, null);
    check("stranger cannot poke", (await stranger.tryPoke(routerId, o9.id)) == #notAuthorized);
    check("stranger cannot read orders", (await stranger.tryGetOrder(routerId, o9.id)) == null);
    check("houdini id attaches once", await router.attachHoudini(o9.id, "h-1"));
    check("houdini id cannot be re-pointed", not (await router.attachHoudini(o9.id, "h-2")));
    check("houdini id attach is idempotent", await router.attachHoudini(o9.id, "h-1"));
    let o9c = await newOrder(alice, null);
    check("an unpaid order can be cancelled by the relay", (await router.cancelUnfunded(o9c.id)) and statusTag(await statusOf(o9c.id)) == "expired");
    let o9d = await newOrder(alice, null);
    await houdiniPays(o9d.depositAccountId, ICP / 20); // at the floor (half this test's 0.1 ICP minimum): a payment
    check("a funded order can't be cancelled", not (await router.cancelUnfunded(o9d.id)));
    let o9e = await newOrder(alice, null);
    ignore await router.attachHoudini(o9e.id, "icp-direct");
    await houdiniPays(o9e.depositAccountId, 50_000); // 0.0005 ICP of dust, e.g. address poisoning
    check("anti-dust floor: 0.5 ICP with a 1 ICP minimum, half the minimum below that", Engine.minDeposit({ cfg with minOrderIcp = ICP }) == ICP / 2 and Engine.minDeposit({ cfg with minOrderIcp = 4 * ICP }) == ICP / 2 and Engine.minDeposit(cfg) == ICP / 20);
    check("dust doesn't start a swap or refund", statusTag(await statusOf(o9e.id)) == "awaitingDeposit" and statusTag(switch (await router.poke(o9e.id)) { case (#processed st) { st }; case _ { #expired } }) == "awaitingDeposit");
    check("an order holding only dust can still be cancelled", (await router.cancelUnfunded(o9e.id)) and statusTag(await statusOf(o9e.id)) == "expired");
    // Dust below the 0.01 ICP floor: never revives the order; the admin (or the end of the
    // late-deposit watch) moves it to the router's stray account.
    await houdiniPays(o9e.depositAccountId, 400_000); // 0.0045 ICP in all
    ignore await router.checkLateDeposits();
    check("dust doesn't revive an expired order", statusTag(await statusOf(o9e.id)) == "expired");
    let strayAcctD = { owner = routerId; subaccount = ?Account.straySubaccount };
    let strayBeforeD = await icp.icrc1_balance_of(strayAcctD);
    check("dust sweep refused for an open order", switch (await router.sweepOrderDust(o9.id)) { case (#err _) { true }; case _ { false } });
    check("stranger can't sweep dust", not (await stranger.trySweepDust(routerId, o9e.id)));
    let sweptD = await router.sweepOrderDust(o9e.id);
    check("admin sweeps the dust to the stray account (" # debug_show sweptD # ")", sweptD == #ok({ icp = 450_000 - icpFee; nak = 0 }) and (await icp.icrc1_balance_of(strayAcctD)) == strayBeforeD + 450_000 - icpFee);
    check("the deposit account is empty and the order still expired", (await icp.icrc1_balance_of({ owner = routerId; subaccount = ?o9e.depositSubaccount })) == 0 and statusTag(await statusOf(o9e.id)) == "expired");
    await houdiniPays(o9e.depositAccountId, ICP / 2);
    check("a real payment revives it instead of being swept", switch (await router.sweepOrderDust(o9e.id)) { case (#err _) { statusTag(await statusOf(o9e.id)) == "awaitingDeposit" }; case _ { false } });
    ignore await pokeUntilSettled(o9e.id);
    // Automatic payout of the stray account to the admin's dust wallet.
    let dustW = Principal.fromBlob("\0B\0D");
    check("dust wallet can't be the pool or the router", not (await router.setDustPayout(?poolId, ICP / 8)) and not (await router.setDustPayout(?routerId, ICP / 8)));
    check("dust wallet set, 0.125 ICP threshold", (await router.setDustPayout(?dustW, ICP / 8)) and (await router.dustPayoutInfo()).minIcp == ICP / 8);
    let strayNow = await icp.icrc1_balance_of(strayAcctD);
    if (strayNow >= ICP / 8) { ignore await router.recoverStray(alice) }; // start from a small balance
    ignore await icp.mint(strayAcctD, ICP / 20);
    await router.runRecovery();
    check("below 0.125 ICP: nothing sent", (await icp.icrc1_balance_of({ owner = dustW; subaccount = null })) == 0);
    ignore await icp.mint(strayAcctD, ICP / 10);
    let strayFull = await icp.icrc1_balance_of(strayAcctD);
    await router.runRecovery();
    check("at 0.125 ICP or more: all of it goes to the dust wallet", (await icp.icrc1_balance_of({ owner = dustW; subaccount = null })) == strayFull - icpFee and (await icp.icrc1_balance_of(strayAcctD)) == 0);
    await router.runRecovery();
    check("nothing sent twice", (await icp.icrc1_balance_of({ owner = dustW; subaccount = null })) == strayFull - icpFee);
    ignore await router.setDustPayout(null, ICP / 8);
    check("strangers can't cancel", not (await stranger.tryCancel(routerId, o9.id)));

    // Admin dashboard guardians.
    let sId = Principal.fromActor(stranger);
    check("admin role", (await router.myRole()) == #admin);
    check("stranger can't freeze or watch", not (await stranger.tryPause(routerId, true)) and not (await stranger.tryOverview(routerId)));
    check("stranger can't request audits", (await stranger.tryAudit(routerId, "x")) == null);
    check("guardian added", await router.addGuardian(sId));
    check("guardian can watch", await stranger.tryOverview(routerId));
    check("guardian can freeze", (await stranger.tryPause(routerId, true)) and (await router.health()).paused);
    check("frozen router refuses new orders", switch (await router.createOrder({ recipient = alice; refundTo = null; minNakOut = null })) { case (#err(#paused)) { true }; case _ { false } });
    check("guardian can unfreeze", (await stranger.tryPause(routerId, false)) and not (await router.health()).paused);
    check("guardian still can't open orders", not (await stranger.tryCreate(routerId, alice)));
    check("guardian can't change the fee", not (await stranger.trySetFee(routerId, alice)));
    let aud = await stranger.tryAudit(routerId, "please check the helpers");
    check("guardian requests an audit", aud == ?0);
    check("one request per 10 minutes", (await stranger.tryAudit(routerId, "again")) == null);
    check("audit requests are listed publicly (no principals)", switch ((await router.auditRequests()).values().next()) { case (?r) { r.note == "please check the helpers" }; case null { false } });
    let ov = switch (await router.adminOverview()) { case (?o) { o }; case null { Runtime.trap("no overview") } };
    check("overview counts orders (" # debug_show ov.counts # ")", ov.counts.size() == 8 and ov.recent.size() > 0 and ov.helpers.size() == 3);
    check("guardian removed", (await router.removeGuardian(sId)) and not (await stranger.tryOverview(routerId)));
    check("oversized houdini id rejected", not (await router.attachHoudini(o0.id, "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")));
    let selfRes = await router.createOrder({ recipient = routerId; refundTo = null; minNakOut = null });
    check("router itself rejected as recipient", switch selfRes { case (#err(#invalidRecipient)) { true }; case _ { false } });
    check("setConfig cannot swap the pool", not (await router.setConfig({ cfg with pool = alice })));
    check("setConfig rejects 50% slippage", not (await router.setConfig({ cfg with slippageBps = 5_000 })));
    check("setConfig rejects min >= max", not (await router.setConfig({ cfg with minOrderIcp = 60 * ICP })));
    check("setConfig accepts sane values", await router.setConfig({ cfg with maxOrderIcp = 30 * ICP }));
    check("config kept the pool", (await router.getConfig()).pool == poolId);
    check("setConfig cannot change ledger fees", not (await router.setConfig({ cfg with nakFee = 0 })));
    check("setConfig cannot make the router its own admin", not (await router.setConfig({ cfg with admin = routerId })));
    check("fee wallet cannot be the router", not (await router.setFee(100, routerId)));
    ignore await router.setConfig({ cfg with maxOrderIcp = 30 * ICP; operators = [me, Principal.fromActor(stranger)] });
    let o9b = await newOrder(alice, null);
    ignore await stranger.tryPoke(routerId, o9b.id);
    check("a non-admin operator is throttled", (await stranger.tryPoke(routerId, o9b.id)) == #tooSoon);
    ignore await router.setConfig({ cfg with maxOrderIcp = 30 * ICP });
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

    // Public stats strip: totals of completed swaps only.
    let st = await router.publicStats();
    var swaps = 0;
    var nakSum = 0;
    for (i in Nat.range(0, 400)) {
      switch (await router.getOrder(i)) {
        case (?v) { switch (v.status) { case (#completed c) { swaps += 1; nakSum += c.nakOut }; case _ {} } };
        case null {};
      };
    };
    check("public stats match the completed orders (" # debug_show st # ")", st.swaps == swaps and st.nakDelivered == nakSum and swaps >= 8 and st.icpSwapped > 0);

    Debug.print(if (failures == 0) { "ALL PASSED" } else { failures.toText() # " FAILED" });
  };
};

Test.run();
