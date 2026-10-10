import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Char "mo:core/Char";
import Int "mo:core/Int";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Text "mo:core/Text";

module {

  // One subaccount per order: 0x4E 0x41 0x4B ("NAK") marker, zeros, then the order id
  // big-endian in the last 8 bytes. Deterministic, so a lost order record can be rebuilt.
  public func orderSubaccount(id : Nat) : Blob {
    Array.tabulate<Nat8>(
      32,
      func i {
        if (i == 0) { 0x4E } else if (i == 1) { 0x41 } else if (i == 2) { 0x4B } else if (i < 24) {
          0
        } else {
          let shift = (31 - i : Int).toNat() * 8;
          ((id / Nat.pow(2, shift)) % 256).toNat8();
        };
      },
    ).toBlob();
  };

  // ICP ledger account identifier: CRC32 || SHA224("\x0Aaccount-id" || principal || subaccount).
  public func accountId(owner : Principal, subaccount : ?Blob) : Blob {
    owner.toLedgerAccount(subaccount);
  };

  let hexChars : [Char] = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'];

  public func toHex(bytes : Blob) : Text {
    var out = "";
    for (b in bytes.toArray().values()) {
      let n = b.toNat();
      out := out # hexChars[n / 16].toText() # hexChars[n % 16].toText();
    };
    out;
  };

  // Little-endian order-id memo so ledger transactions can be traced back to orders.
  public func memo(id : Nat) : Blob {
    Array.tabulate<Nat8>(8, func i = ((id / Nat.pow(2, i * 8)) % 256).toNat8()).toBlob();
  };
};
