// ICRC-1 textual account encoding (owner principal + subaccount), the format wallets such as
// Plug and Oisy accept: `<principal>-<checksum>.<subaccount hex without leading zeros>`.
// Spec: https://github.com/dfinity/ICRC-1/blob/main/standards/ICRC-1/TextualEncoding.md
import { Principal } from '@icp-sdk/core/principal';

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

// CRC-32 (IEEE), table-driven; no dependency on a particular Node version.
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function base32(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = ((value << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function encodeIcrcAccount(owner, subaccount) {
  const p = typeof owner === 'string' ? Principal.fromText(owner) : owner;
  const sub = subaccount ? Uint8Array.from(subaccount) : new Uint8Array(32);
  if (sub.length !== 32) throw new Error('subaccount must be 32 bytes');
  if (sub.every((b) => b === 0)) return p.toText();
  const ownerBytes = p.toUint8Array();
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(ownerBytes), Buffer.from(sub)])));
  const hex = Buffer.from(sub).toString('hex').replace(/^0+/, '');
  return `${p.toText()}-${base32(crc)}.${hex}`;
}
