module {
  /// Monotonic order identifier.
  public type OrderId = Nat;

  /// Nanoseconds since the epoch (Time.now()).
  public type Timestamp = Int;

  /// 64-hex ICP account identifier (CRC32 + SHA224 of the account-id preimage).
  public type AccountId = Text;

  /// A 32-byte subaccount.
  public type Subaccount = Blob;

  /// Amount in the smallest unit of a token (e8s for ICP, 8-decimal units for NAK).
  public type Amount = Nat;

  /// Basis points (1 bps = 0.01%).
  public type Bps = Nat;

  /// Ledger block index.
  public type BlockIndex = Nat;

  /// The Houdini route type: Standard (faster, ~0.8% fee) or Private (slower, ~1.5% fee).
  public type RouteType = {
    #standard;
    #private_;
  };
};
