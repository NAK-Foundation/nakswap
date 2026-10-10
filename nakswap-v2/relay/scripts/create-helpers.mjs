// Creates the NAKSwap swap-helper canisters on mainnet and installs the helper wasm.
// Each helper: ICP -> CMC (CREA memo) -> new canister controlled by the deployer and the
// admin, then install with (router, ICP ledger, NAK ledger, pool, icpIsToken0), then a
// 90-day freezing threshold. Prints the ids to pass to the router's setHelpers.
//
//   DEPLOYER_SEED=<hex> ADMIN_PID=<principal> ROUTER_ID=<router> WASM=../build/helper.wasm \
//   COUNT=3 ICP_EACH=0.6 [SUBNET=<subnet principal>] [EXTRA_CONTROLLERS=<p1,p2>] node scripts/create-helpers.mjs
//
// Upgrade existing helpers instead: MODE=upgrade HELPER_IDS=id1,id2,id3 (stops, installs,
// starts each one).
import crypto from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { Actor, HttpAgent } from '@icp-sdk/core/agent';
import { IDL } from '@icp-sdk/core/candid';
import { Ed25519KeyIdentity } from '@icp-sdk/core/identity';
import { Principal } from '@icp-sdk/core/principal';

const env = process.env;
const need = (k) => env[k] || (console.error(`missing ${k}`), process.exit(1));
const ICP_LEDGER = Principal.fromText('ryjl3-tyaaa-aaaaa-aaaba-cai');
const NAK_LEDGER = Principal.fromText('eig2s-waaaa-aaaam-qbg5a-cai');
const POOL = Principal.fromText('d6hdt-qiaaa-aaaag-qm76q-cai');
const CMC = Principal.fromText('rkp4c-7iaaa-aaaaa-aaaca-cai');
const MEMO_CREATE_CANISTER = 0x41455243n;
const FEE = 10_000n;

const identity = Ed25519KeyIdentity.generate(Uint8Array.from(Buffer.from(need('DEPLOYER_SEED'), 'hex')));
const deployer = identity.getPrincipal();
const admin = Principal.fromText(need('ADMIN_PID'));
const router = Principal.fromText(need('ROUTER_ID'));
// e.g. the CycleOps balance checker, so the helpers have the same controllers as the router
// (the router's setHelpers requires that).
const extraControllers = (env.EXTRA_CONTROLLERS || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => Principal.fromText(x));
const wasm = fs.readFileSync(need('WASM'));
const agent = await HttpAgent.create({ host: env.IC_HOST || 'https://icp-api.io', identity });
const show = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));

function accountId(owner, sub = new Uint8Array(32)) {
  const h = crypto
    .createHash('sha224')
    .update(Buffer.concat([Buffer.from('\x0Aaccount-id'), Buffer.from(owner.toUint8Array()), Buffer.from(sub)]))
    .digest();
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(h));
  return Uint8Array.from(Buffer.concat([crc, h]));
}
function principalSubaccount(p) {
  const bytes = p.toUint8Array();
  const sub = new Uint8Array(32);
  sub[0] = bytes.length;
  sub.set(bytes, 1);
  return sub;
}

const ledger = Actor.createActor(
  ({ IDL }) => {
    const Tokens = IDL.Record({ e8s: IDL.Nat64 });
    return IDL.Service({
      icrc1_balance_of: IDL.Func([IDL.Record({ owner: IDL.Principal, subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)) })], [IDL.Nat], ['query']),
      transfer: IDL.Func(
        [
          IDL.Record({
            memo: IDL.Nat64,
            amount: Tokens,
            fee: Tokens,
            from_subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
            to: IDL.Vec(IDL.Nat8),
            created_at_time: IDL.Opt(IDL.Record({ timestamp_nanos: IDL.Nat64 })),
          }),
        ],
        [IDL.Variant({ Ok: IDL.Nat64, Err: IDL.Reserved })],
        [],
      ),
    });
  },
  { agent, canisterId: ICP_LEDGER },
);

const cmc = Actor.createActor(
  ({ IDL }) => {
    const Settings = IDL.Record({ controllers: IDL.Opt(IDL.Vec(IDL.Principal)) });
    const SubnetSelection = IDL.Variant({
      Subnet: IDL.Record({ subnet: IDL.Principal }),
      Filter: IDL.Record({ subnet_type: IDL.Opt(IDL.Text) }),
    });
    const NotifyError = IDL.Variant({
      Refunded: IDL.Record({ reason: IDL.Text, block_index: IDL.Opt(IDL.Nat64) }),
      Processing: IDL.Null,
      TransactionTooOld: IDL.Nat64,
      InvalidTransaction: IDL.Text,
      Other: IDL.Record({ error_code: IDL.Nat64, error_message: IDL.Text }),
    });
    return IDL.Service({
      notify_create_canister: IDL.Func(
        [
          IDL.Record({
            block_index: IDL.Nat64,
            controller: IDL.Principal,
            subnet_type: IDL.Opt(IDL.Text),
            subnet_selection: IDL.Opt(SubnetSelection),
            settings: IDL.Opt(Settings),
          }),
        ],
        [IDL.Variant({ Ok: IDL.Principal, Err: NotifyError })],
        [],
      ),
    });
  },
  { agent, canisterId: CMC },
);

const mgmtFor = (canisterId) =>
  Actor.createActor(
    ({ IDL }) =>
      IDL.Service({
        install_code: IDL.Func(
          [
            IDL.Record({
              mode: IDL.Variant({
                install: IDL.Null,
                reinstall: IDL.Null,
                upgrade: IDL.Opt(
                  IDL.Record({
                    skip_pre_upgrade: IDL.Opt(IDL.Bool),
                    wasm_memory_persistence: IDL.Opt(IDL.Variant({ keep: IDL.Null, replace: IDL.Null })),
                  }),
                ),
              }),
              canister_id: IDL.Principal,
              wasm_module: IDL.Vec(IDL.Nat8),
              arg: IDL.Vec(IDL.Nat8),
              sender_canister_version: IDL.Opt(IDL.Nat64),
            }),
          ],
          [],
          [],
        ),
        update_settings: IDL.Func(
          [
            IDL.Record({
              canister_id: IDL.Principal,
              settings: IDL.Record({ freezing_threshold: IDL.Opt(IDL.Nat) }),
              sender_canister_version: IDL.Opt(IDL.Nat64),
            }),
          ],
          [],
          [],
        ),
        stop_canister: IDL.Func([IDL.Record({ canister_id: IDL.Principal })], [], []),
        start_canister: IDL.Func([IDL.Record({ canister_id: IDL.Principal })], [], []),
      }),
    { agent, canisterId: Principal.fromText('aaaaa-aa'), effectiveCanisterId: canisterId },
  );

const initArg = new Uint8Array(
  IDL.encode([IDL.Principal, IDL.Principal, IDL.Principal, IDL.Principal, IDL.Bool], [router, ICP_LEDGER, NAK_LEDGER, POOL, false]),
);

async function create(icpEach, subnet) {
  const amount = BigInt(Math.round(icpEach * 1e8));
  const tx = await ledger.transfer({
    memo: MEMO_CREATE_CANISTER,
    amount: { e8s: amount },
    fee: { e8s: FEE },
    from_subaccount: [],
    to: accountId(CMC, principalSubaccount(deployer)),
    created_at_time: [{ timestamp_nanos: BigInt(Date.now()) * 1_000_000n }],
  });
  if (!('Ok' in tx)) throw new Error(`ICP transfer to CMC failed: ${show(tx)}`);
  const block = tx.Ok;
  for (let attempt = 0; attempt < 15; attempt++) {
    const r = await cmc.notify_create_canister({
      block_index: block,
      controller: deployer,
      subnet_type: [],
      subnet_selection: subnet ? [{ Subnet: { subnet } }] : [],
      settings: [{ controllers: [[deployer, admin, ...extraControllers]] }],
    });
    if ('Ok' in r) return r.Ok;
    if ('Processing' in r.Err) {
      await new Promise((res) => setTimeout(res, 3000));
      continue;
    }
    throw new Error(`notify_create_canister failed: ${show(r.Err)}`);
  }
  throw new Error(`CMC still processing block ${block}; rerun notify later`);
}

if (env.MODE === 'upgrade') {
  for (const id of need('HELPER_IDS').split(',').map((s) => Principal.fromText(s.trim()))) {
    const m = mgmtFor(id);
    await m.stop_canister({ canister_id: id });
    try {
      await m.install_code({
        mode: { upgrade: [{ skip_pre_upgrade: [], wasm_memory_persistence: [{ keep: null }] }] },
        canister_id: id,
        wasm_module: Uint8Array.from(wasm),
        arg: initArg,
        sender_canister_version: [],
      });
    } finally {
      await m.start_canister({ canister_id: id });
    }
    console.log('upgraded', id.toText());
  }
  process.exit(0);
}

const count = Number(env.COUNT || 3);
const icpEach = Number(env.ICP_EACH || 0.6);
const subnet = env.SUBNET ? Principal.fromText(env.SUBNET) : null;
console.log('deployer', deployer.toText(), 'balance', Number(await ledger.icrc1_balance_of({ owner: deployer, subaccount: [] })) / 1e8, 'ICP');
const ids = [];
for (let i = 0; i < count; i++) {
  let id;
  try {
    id = await create(icpEach, subnet);
  } catch (e) {
    if (!subnet) throw e;
    console.log(`subnet ${subnet.toText()} not available (${e.message.slice(0, 120)}); using the default`);
    id = await create(icpEach, null);
  }
  console.log(`created helper ${i}: ${id.toText()}`);
  const m = mgmtFor(id);
  await m.install_code({ mode: { install: null }, canister_id: id, wasm_module: Uint8Array.from(wasm), arg: initArg, sender_canister_version: [] });
  await m.update_settings({ canister_id: id, settings: { freezing_threshold: [90n * 86_400n] }, sender_canister_version: [] });
  console.log(`installed helper ${i}`);
  ids.push(id.toText());
}
console.log(`\nHELPER_IDS=${ids.join(',')}`);
