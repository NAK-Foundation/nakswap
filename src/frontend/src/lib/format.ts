import { ACCOUNT_ID_HEX_LENGTH, E8S } from "@/lib/constants";

/**
 * Format a base-unit amount (bigint) with a fixed number of decimals.
 * Uses tabular grouping for the integer part and truncates the fraction
 * rather than rounding, so displayed values never overstate a balance.
 */
export function formatUnits(
  value: bigint | null | undefined,
  decimals: number,
  options: { maxFractionDigits?: number } = {},
): string {
  if (value === null || value === undefined) return "—";
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = abs % base;

  const maxFractionDigits = options.maxFractionDigits ?? decimals;
  let fractionStr = fraction.toString().padStart(decimals, "0");
  if (maxFractionDigits < decimals) {
    fractionStr = fractionStr.slice(0, maxFractionDigits);
  }
  fractionStr = fractionStr.replace(/0+$/, "");

  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sign = negative ? "-" : "";
  return fractionStr.length > 0
    ? `${sign}${wholeStr}.${fractionStr}`
    : `${sign}${wholeStr}`;
}

/** Format an ICP amount held as e8s. */
export function formatIcp(
  value: bigint | null | undefined,
  options?: { maxFractionDigits?: number },
): string {
  return formatUnits(value, 8, options);
}

/** Format a NAK amount (8 decimals). */
export function formatNak(
  value: bigint | null | undefined,
  options?: { maxFractionDigits?: number },
): string {
  return formatUnits(value, 8, options);
}

/** Format an ICP amount with its symbol, e.g. "1.5 ICP". */
export function formatIcpWithSymbol(value: bigint | null | undefined): string {
  return `${formatIcp(value)} ICP`;
}

/** Format a NAK amount with its symbol, e.g. "1.5 NAK". */
export function formatNakWithSymbol(value: bigint | null | undefined): string {
  return `${formatNak(value)} NAK`;
}

/**
 * Shorten a 64-hex account id to a readable head…tail form.
 * Non-hex or short values are returned unchanged.
 */
export function formatAccountId(
  accountId: string | null | undefined,
  head = 8,
  tail = 6,
): string {
  if (!accountId) return "—";
  if (accountId.length <= head + tail + 1) return accountId;
  return `${accountId.slice(0, head)}…${accountId.slice(-tail)}`;
}

/** True when the string looks like a full 64-hex account id. */
export function isFullAccountId(value: string): boolean {
  return value.length === ACCOUNT_ID_HEX_LENGTH && /^[0-9a-fA-F]+$/.test(value);
}

/** Format a principal to a shortened head…tail form. */
export function formatPrincipal(
  principal: string | null | undefined,
  head = 5,
  tail = 4,
): string {
  if (!principal) return "—";
  if (principal.length <= head + tail + 1) return principal;
  return `${principal.slice(0, head)}…${principal.slice(-tail)}`;
}

/**
 * Convert a Motoko nanosecond timestamp (bigint) to a Date.
 * Returns null when the value cannot be represented.
 */
export function timestampToDate(
  timestamp: bigint | null | undefined,
): Date | null {
  if (timestamp === null || timestamp === undefined) return null;
  const ms = Number(timestamp / 1_000_000n);
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Format a nanosecond timestamp as a compact local date-time. */
export function formatTimestamp(timestamp: bigint | null | undefined): string {
  const date = timestampToDate(timestamp);
  if (!date) return "—";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Format basis points as a percentage string, e.g. 50n -> "0.50%". */
export function formatBps(bps: bigint | null | undefined): string {
  if (bps === null || bps === undefined) return "—";
  const negative = bps < 0n;
  const abs = negative ? -bps : bps;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${frac}%`;
}

/** Format a duration in seconds as a compact human string. */
export function formatDuration(seconds: bigint | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  const total = Number(seconds);
  if (!Number.isFinite(total) || total < 0) return "—";
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

/** Parse a decimal string into base units (bigint). Returns null when invalid. */
export function parseUnits(input: string, decimals: number): bigint | null {
  const trimmed = input.trim();
  if (trimmed === "" || !/^\d*\.?\d*$/.test(trimmed)) return null;
  const [wholePart = "", fractionPart = ""] = trimmed.split(".");
  if (wholePart === "" && fractionPart === "") return null;
  const paddedFraction = fractionPart.padEnd(decimals, "0").slice(0, decimals);
  try {
    const whole = wholePart === "" ? 0n : BigInt(wholePart);
    const fraction = paddedFraction === "" ? 0n : BigInt(paddedFraction);
    return whole * 10n ** BigInt(decimals) + fraction;
  } catch {
    return null;
  }
}

/** Parse an ICP decimal string into e8s. */
export function parseIcp(input: string): bigint | null {
  return parseUnits(input, 8);
}

/** Format a bigint as a plain decimal string (no grouping). */
export function formatRaw(value: bigint | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value.toString();
}

/**
 * Format a USD price held as micro-dollars (1e6) as "$1,234.56".
 * Values below a cent keep more precision so cheap tokens stay legible.
 */
export function formatUsdMicro(value: bigint | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 1_000_000n;
  const cents = ((abs % 1_000_000n) / 10_000n).toString().padStart(2, "0");
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}$${wholeStr}.${cents}`;
}

/** Parse a USD decimal string into micro-dollars. Returns null when invalid. */
export function parseUsdMicro(input: string): bigint | null {
  const trimmed = input.trim().replace(/^\$/, "");
  if (trimmed === "" || !/^\d*\.?\d*$/.test(trimmed)) return null;
  const [wholePart = "", fractionPart = ""] = trimmed.split(".");
  if (wholePart === "" && fractionPart === "") return null;
  const paddedFraction = fractionPart.padEnd(6, "0").slice(0, 6);
  try {
    const whole = wholePart === "" ? 0n : BigInt(wholePart);
    const fraction = paddedFraction === "" ? 0n : BigInt(paddedFraction);
    return whole * 1_000_000n + fraction;
  } catch {
    return null;
  }
}

/** Re-export the e8s constant for convenience at call sites. */
export { E8S };
