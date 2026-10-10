// Deploys the NAKSwap router canister to ICP mainnet with plain ICP (no dfx / icp-cli):
//   1. sends the deployer's ICP to the Cycles Minting Canister with the CREA memo,
//   2. asks the CMC to create a canister controlled by the deployer AND the admin,
//   3. installs (or upgrades) the router wasm with its Config.
//
// Usage (from relay/):
//   DEPLOYER_SEED=<64 hex> ADMIN_PID=<your principal> OPERATOR_PID=<relay principal> \
//   WASM=../build/router.wasm node scripts/deploy-router.mjs
// Optional: CANISTER_ID=<id> to skip creation (install into / upgrade an existing canister),
//           MODE=install|upgrade (default install), TICK_SECONDS (default 20), DRY_RUN=1.
import crypto from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { Actor, HttpAgent } from '@icp-sdk/core/agent';
import { IDL } from '@icp-sdk/core/candid';
import { Ed25519KeyIdentity } from '@icp-sdk/core/identity';
import { Principal } from '@icp-sdk/core/principal';
import { routerIdl } from '../src/idl.js';

const env = process.env;
const need = (k) => env[k] || (console.error(`missing ${k}`), process.exit(1));

const ICP_LEDGER = Principal.fromText('ryjl3-tyaaa-aaaaa-aaaba-cai');
const CMC = Principal.fromText('rkp4c-7iaaa-aaaaa-aaaca-cai');
const MEMO_CREATE_CANISTER = 0x41455243n; // "CREA"
const FEE = 10_000n;

const identity = Ed25519KeyIdentity.generate(Uint8Array.from(Buffer.from(need('DEPLOYER_SEED'), 'hex')));
const deployer = identity.getPrincipal();
const admin = Principal.fromText(need('ADMIN_PID'));
const operator = Principal.fromText(need('OPERATOR_PID'));
const wasm = fs.readFileSync(need('WASM'));
const tickSeconds = BigInt(env.TICK_SECONDS || 20);
const dryRun = env.DRY_RUN === '1';

const agent = await HttpAgent.create({ host: env.IC_HOST || 'https://icp-api.io', identity });

// ---------- account identifiers ----------
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

// ---------- interfaces ----------
const ledger = Actor.createActor(
  ({ IDL }) => {
    const Tokens = IDL.Record({ e8s: IDL.Nat64 });
    return IDL.Service({
      icrc1_balance_of: IDL.Func(
        [IDL.Record({ owner: IDL.Principal, subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)) })],
        [IDL.Nat],
        ['query'],
      ),
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
        [
          IDL.Variant({
            Ok: IDL.Nat64,
            Err: IDL.Variant({
              BadFee: IDL.Record({ expected_fee: Tokens }),
              InsufficientFunds: IDL.Record({ balance: Tokens }),
              TxTooOld: IDL.Record({ allowed_window_nanos: IDL.Nat64 }),
              TxCreatedInFuture: IDL.Null,
              TxDuplicate: IDL.Record({ duplicate_of: IDL.Nat64 }),
            }),
          }),
        ],
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

const managementFor = (canisterId) =>
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
      }),
    { agent, canisterId: Principal.fromText('aaaaa-aa'), effectiveCanisterId: canisterId },
  );

// ---------- router init args ----------
const Config = IDL.Record({
  admin: IDL.Principal,
  operators: IDL.Vec(IDL.Principal),
  icpLedger: IDL.Principal,
  nakLedger: IDL.Principal,
  pool: IDL.Principal,
  icpIsToken0: IDL.Bool,
  icpFee: IDL.Nat,
  nakFee: IDL.Nat,
  slippageBps: IDL.Nat,
  maxImpactBps: IDL.Nat,
  minOrderIcp: IDL.Nat,
  maxOrderIcp: IDL.Nat,
  orderTtlSeconds: IDL.Nat,
  paused: IDL.Bool,
});
const config = {
  admin,
  operators: [operator],
  icpLedger: ICP_LEDGER,
  nakLedger: Principal.fromText('eig2s-waaaa-aaaam-qbg5a-cai'),
  pool: Principal.fromText('d6hdt-qiaaa-aaaag-qm76q-cai'),
  icpIsToken0: false,
  icpFee: 10_000n,
  nakFee: 1_000_000n,
  slippageBps: 100n,
  maxImpactBps: 500n,
  minOrderIcp: 10_000_000n, // 0.1 ICP
  maxOrderIcp: 1_000_000_000n, // 10 ICP while testing
  orderTtlSeconds: 7_200n,
  paused: false,
};
const initArg = new Uint8Array(IDL.encode([Config, IDL.Nat], [config, tickSeconds]));

// ---------- run ----------
console.log('deployer ', deployer.toText());
console.log('admin    ', admin.toText());
console.log('operator ', operator.toText());
console.log('wasm     ', wasm.length, 'bytes, sha256', crypto.createHash('sha256').update(wasm).digest('hex'));

let canisterId = env.CANISTER_ID ? Principal.fromText(env.CANISTER_ID) : null;

if (!canisterId) {
  const balance = await ledger.icrc1_balance_of({ owner: deployer, subaccount: [] });
  console.log('balance  ', Number(balance) / 1e8, 'ICP');
  if (balance < 50_000_000n) {
    console.error('Need at least 0.5 ICP on the deployer account to create the canister.');
    process.exit(2);
  }
  const amount = balance - FEE;
  if (dryRun) {
    console.log(`DRY RUN: would send ${Number(amount) / 1e8} ICP to the CMC and create the canister`);
    process.exit(0);
  }
  const to = accountId(CMC, principalSubaccount(deployer));
  const tx = await ledger.transfer({
    memo: MEMO_CREATE_CANISTER,
    amount: { e8s: amount },
    fee: { e8s: FEE },
    from_subaccount: [],
    to,
    created_at_time: [{ timestamp_nanos: BigInt(Date.now()) * 1_000_000n }],
  });
  if ('Err' in tx) throw new Error(`ICP transfer to CMC failed: ${JSON.stringify(tx.Err, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
  const block = tx.Ok;
  console.log('paid CMC in ICP ledger block', block.toString());

  for (let attempt = 0; attempt < 10; attempt++) {
    const r = await cmc.notify_create_canister({
      block_index: block,
      controller: deployer,
      subnet_type: [],
      subnet_selection: [],
      settings: [{ controllers: [[deployer, admin]] }],
    });
    if ('Ok' in r) {
      canisterId = r.Ok;
      break;
    }
    if ('Processing' in r.Err) {
      await new Promise((res) => setTimeout(res, 3000));
      continue;
    }
    throw new Error(`notify_create_canister failed: ${JSON.stringify(r.Err, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
  }
  if (!canisterId) throw new Error('CMC still processing; rerun with the same block later');
  console.log('created  ', canisterId.toText());
}

if (dryRun) {
  console.log('DRY RUN: would install into', canisterId.toText());
  process.exit(0);
}

const mode =
  env.MODE === 'upgrade' ? { upgrade: [{ skip_pre_upgrade: [], wasm_memory_persistence: [{ keep: null }] }] } : { install: null };
await managementFor(canisterId).install_code({
  mode,
  canister_id: canisterId,
  wasm_module: Uint8Array.from(wasm),
  arg: env.MODE === 'upgrade' ? new Uint8Array(IDL.encode([Config, IDL.Nat], [config, tickSeconds])) : initArg,
  sender_canister_version: [],
});
console.log('installed', env.MODE || 'install');

const router = Actor.createActor(routerIdl, { agent, canisterId });
const cfg = await router.getConfig();
console.log('router config ok: pool', cfg.pool.toText(), 'admin', cfg.admin.toText());
console.log(`\nROUTER_CANISTER_ID=${canisterId.toText()}`);
