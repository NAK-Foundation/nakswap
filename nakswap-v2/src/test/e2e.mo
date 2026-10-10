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

    // ---- 6b. admin recovers it: pool unused balance -> main -> capped refund ----
    Debug.print("6b. recover from the pool");
    let unused = switch (await router.poolUnusedBalance()) { case (#ok b) { b.icp }; case (#err _) { 0 } };
    check("pool holds the order's ICP as unused balance (" # unused.toText() # ")", unused > 0);
    check("withdrawFromPool works", (await router.withdrawFromPool(true, unused)) == #ok(unused));
    let mainIcp = await icp.icrc1_balance_of(routerMain);
    let accrued6 = (await router.feeStatus()).accrued;
    let refundable6 = mainIcp - accrued6 - icpFee : Nat;
    check("forceRefund above what main can spare is refused", statusTag((await router.forceRefund(o6.id, refundable6 + 1, false)) ?? #expired).startsWith(#text "needsReview"));
    check("forceRefund from an empty deposit is refused", statusTag((await router.forceRefund(o6.id, ICP / 2, true)) ?? #expired).startsWith(#text "needsReview"));
    let aliceBefore = await icp.icrc1_balance_of({ owner = alice; subaccount = null });
    check("capped forceRefund accepted", statusTag((await router.forceRefund(o6.id, refundable6, false)) ?? #expired) == "refundPending");
    check("then refunded", statusTag(await pokeUntilSettled(o6.id)) == "refunded");
    check("alice got the refund", (await icp.icrc1_balance_of({ owner = alice; subaccount = null })) == aliceBefore + refundable6);
    check("fees left untouched in main", (await icp.icrc1_balance_of(routerMain)) == accrued6);

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
    check("stray deposit recovered (" # debug_show rec # ")", rec == #ok(ICP - icpFee) and (await icp.icrc1_balance_of({ owner = frank; subaccount = null })) == ICP - icpFee);
    check("recover refuses unknown order ids", switch (await router.recoverDeposit(o7.id + 100, frank)) { case (#err _) { true }; case _ { false } });
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

    // ---- 10. swap helpers: parallel swaps, each settled in its own deposit account ----
    Debug.print("10. swap helpers");
    let h0 = await HelperMod.Helper(routerId, icpId, nakId, poolId, false);
    let h1 = await HelperMod.Helper(routerId, icpId, nakId, poolId, false);
    let h2 = await HelperMod.Helper(routerId, icpId, nakId, poolId, false);
    let hIds = [Principal.fromActor(h0), Principal.fromActor(h1), Principal.fromActor(h2)];
    check("setHelpers rejects duplicates", not (await router.setHelpers([hIds[0], hIds[0]])));
    check("setHelpers rejects the router itself", not (await router.setHelpers([routerId])));
    check("setHelpers accepts three helpers", await router.setHelpers(hIds));
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

    // 10d. the pool keeps the ICP: the helper pulls it back itself and the user is refunded
    let ivy = Principal.fromBlob("\0A\06");
    let o10d = await newOrder(ivy, null);
    await houdiniPays(o10d.depositAccountId, ICP);
    await pool.setBreakNextSwap(true);
    let s10d = await pokeUntilSettled(o10d.id);
    check("refunded without admin help (got " # statusTag(s10d) # ")", statusTag(s10d) == "refunded");
    let ivyIcp = await icp.icrc1_balance_of({ owner = ivy; subaccount = null });
    check("ivy got her ICP back (" # ivyIcp.toText() # ")", ivyIcp > ICP - 10 * icpFee and ivyIcp < ICP);
    check("no helper quarantined by a clean failure", (await router.helpers()).all(func(i : Types.HelperInfo) : Bool = not i.quarantined));

    // 10e. fees in the deposit accounts are swept to the fee wallet
    let feesExpected = (5 * ICP / 100 - icpFee) + (1 * ICP / 100 - icpFee) + (2 * ICP / 100 - icpFee) + (3 * ICP / 100 - icpFee);
    let swept10 = await router.sweepFees();
    check("swept the four helper-path fees (" # swept10.toText() # " vs " # feesExpected.toText() # ")", swept10 == feesExpected);
    check("fee wallet received them", (await icp.icrc1_balance_of({ owner = feeWallet; subaccount = null })) == feeWalletBefore + feesExpected);
    check("nothing left to sweep", (await router.sweepFees()) == 0 and (await router.feeStatus()).accrued == 0);

    // 10f. helpers holding someone else's money are never used; the router falls back
    Debug.print("10f. dirty helpers");
    for (h in hIds.values()) { ignore await icp.mint({ owner = h; subaccount = null }, ICP / 10) };
    let jill = Principal.fromBlob("\0A\07");
    let o10f = await newOrder(jill, null);
    await houdiniPays(o10f.depositAccountId, ICP);
    let s10f = await pokeUntilSettled(o10f.id);
    check("order still completes (got " # statusTag(s10f) # ")", statusTag(s10f) == "completed");
    check("jill got NAK", (await nak.icrc1_balance_of({ owner = jill; subaccount = null })) > 0);
    check("every dirty helper is quarantined", (await router.helpers()).all(func(i : Types.HelperInfo) : Bool = i.quarantined));
    var helperIcpLeft = 0;
    for (h in hIds.values()) { helperIcpLeft += await icp.icrc1_balance_of({ owner = h; subaccount = null }) };
    check("their stray ICP was not touched by jill's swap", helperIcpLeft == 3 * (ICP / 10));
    let mainBefore10f = await icp.icrc1_balance_of(routerMain);
    var recovered = 0;
    var k10 = 0;
    while (k10 < 3) {
      switch (await router.helperRecover(k10, null)) { case (#ok r) { recovered += r.icp }; case (#err _) {} };
      check("helper " # k10.toText() # " cleared", await router.clearHelper(k10));
      k10 += 1;
    };
    check("admin recovered the stray ICP to the router", recovered == 3 * (ICP / 10 - icpFee) and (await icp.icrc1_balance_of(routerMain)) == mainBefore10f + recovered);
    check("helpers back in rotation", (await router.helpers()).all(func(i : Types.HelperInfo) : Bool = not i.quarantined));
    let kim = Principal.fromBlob("\0A\08");
    let o10g = await newOrder(kim, null);
    await houdiniPays(o10g.depositAccountId, ICP);
    check("next order goes through a helper again", statusTag(await pokeUntilSettled(o10g.id)) == "completed" and (await nak.icrc1_balance_of(routerMain)) == mainNakBefore);

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

    Debug.print(if (failures == 0) { "ALL PASSED" } else { failures.toText() # " FAILED" });
  };
};

Test.run();
