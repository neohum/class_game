/**
 * fetch.ts — Core fetch boundary, SSRF validation, and FetcherService implementation.
 *
 * Implements FetcherPort: fetches external sources (GitHub repos, stars, web pages)
 * into standardized DocumentRevisions with content hashing, ETag/Last-Modified detection,
 * rate limit backoff, transient error preservation, and rigorous SSRF protection.
 *
 * SAFETY INVARIANT: Never executes remote or local code/scripts. Rejects private/loopback IPs.
 */

import net from "node:net";
import dns from "node:dns/promises";
import {
  type DocumentRevision,
  FetchError,
  type FetcherPort,
  IntakeError,
  type PortOptions,
  type SourceSpec,
  withPortTimeout,
} from "./contracts.ts";
import { GitHubConnector } from "./connectors/github.ts";
import { WebConnector } from "./connectors/web.ts";

export interface FetchOptions extends PortOptions {
  maxSizeBytes?: number;
  allowPrivateNetwork?: boolean;
  confirmTombstone?: boolean;
  fetchFn?: typeof fetch;
  githubToken?: string;
  dnsLookup?: (hostname: string) => Promise<string[]>;
  throwOnFailure?: boolean;
}

/**
 * Checks whether an IPv4 address is in a private, loopback, link-local, multicast, or reserved range.
 */
function isRestrictedIPv4(a: number, b: number, c: number, d: number): boolean {
  // 0/8 (Current network)
  if (a === 0) return true;
  // 10/8 (RFC 1918 Private network)
  if (a === 10) return true;
  // 100.64/10 (CGNAT)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 127/8 (Loopback)
  if (a === 127) return true;
  // 169.254/16 (Link-local / cloud metadata)
  if (a === 169 && b === 254) return true;
  // 172.16/12 (RFC 1918 Private network)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.0.0/24 (IETF Protocol Assignments)
  if (a === 192 && b === 0 && c === 0) return true;
  // 192.0.2/24 (TEST-NET-1)
  if (a === 192 && b === 0 && c === 2) return true;
  // 192.88.99/24 (6to4 Relay)
  if (a === 192 && b === 88 && c === 99) return true;
  // 192.168/16 (RFC 1918 Private network)
  if (a === 192 && b === 168) return true;
  // 198.18/15 (Network Interconnect Benchmark)
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 198.51.100/24 (TEST-NET-2)
  if (a === 198 && b === 51 && c === 100) return true;
  // 203.0.113/24 (TEST-NET-3)
  if (a === 203 && b === 0 && c === 113) return true;
  // 224/4 (Multicast)
  if (a >= 224 && a <= 239) return true;
  // 240/4 (Reserved / Future use / Broadcast)
  if (a >= 240) return true;

  return false;
}

/**
 * Expands an IPv6 address string into eight 16-bit words.
 */
function parseIPv6Words(ip: string): [number, number, number, number, number, number, number, number] | null {
  let clean = ip.toLowerCase();
  // Handle IPv4-mapped IPv6 in dotted decimal notation e.g. ::ffff:a.b.c.d
  if (clean.includes(".")) {
    const lastColon = clean.lastIndexOf(":");
    const v4part = clean.slice(lastColon + 1);
    const parts = v4part.split(".").map(Number);
    if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
      return null;
    }
    const [p0, p1, p2, p3] = parts as [number, number, number, number];
    const hi = ((p0 << 8) | p1) >>> 0;
    const lo = ((p2 << 8) | p3) >>> 0;
    clean = clean.slice(0, lastColon) + `:${hi.toString(16)}:${lo.toString(16)}`;
  }

  const doubleColonCount = (clean.match(/::/g) || []).length;
  if (doubleColonCount > 1) return null;

  const halves = clean.split("::");
  const left = halves[0] ? halves[0].split(":").filter(Boolean) : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(":").filter(Boolean) : [];

  const missing = 8 - (left.length + right.length);
  if (missing < 0) return null;

  const middle = new Array(missing).fill("0");
  const full = [...left, ...middle, ...right];
  if (full.length !== 8) return null;

  const parsed = full.map((seg) => parseInt(seg, 16));
  return parsed as [number, number, number, number, number, number, number, number];
}

/**
 * Validates whether an IP address is private, loopback, link-local, multicast, or reserved.
 */
export function isPrivateOrRestrictedIp(rawIp: string): boolean {
  if (!rawIp || typeof rawIp !== "string") return true;
  const ip = rawIp.trim().toLowerCase().replace(/^\[|\]$/g, "");

  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
      return true;
    }
    const [a, b, c, d] = parts as [number, number, number, number];
    return isRestrictedIPv4(a, b, c, d);
  }

  if (net.isIPv6(ip) || ip.includes(":")) {
    const words = parseIPv6Words(ip);
    if (!words) return true; // Malformed treated as restricted

    const [w0, w1, w2, w3, w4, w5, w6, w7] = words;

    // Loopback ::1
    if (
      w0 === 0 &&
      w1 === 0 &&
      w2 === 0 &&
      w3 === 0 &&
      w4 === 0 &&
      w5 === 0 &&
      w6 === 0 &&
      w7 === 1
    ) {
      return true;
    }

    // Unspecified ::
    if (words.every((w) => w === 0)) {
      return true;
    }

    // IPv4-mapped IPv6 (::ffff:0:0/96 or ::ffff:a.b.c.d)
    if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0xffff) {
      const a = (w6 >> 8) & 0xff;
      const b = w6 & 0xff;
      const c = (w7 >> 8) & 0xff;
      const d = w7 & 0xff;
      return isRestrictedIPv4(a, b, c, d);
    }

    // NAT64 64:ff9b::/96
    if (w0 === 0x0064 && w1 === 0xff9b && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) {
      const a = (w6 >> 8) & 0xff;
      const b = w6 & 0xff;
      const c = (w7 >> 8) & 0xff;
      const d = w7 & 0xff;
      return isRestrictedIPv4(a, b, c, d);
    }

    // Unique local address fc00::/7 (fc00:: to fdff::)
    if ((w0 & 0xfe00) === 0xfc00) {
      return true;
    }

    // Link-local unicast fe80::/10 (fe80:: to febf::)
    if ((w0 & 0xffc0) === 0xfe80) {
      return true;
    }

    // Multicast ff00::/8
    if ((w0 & 0xff00) === 0xff00) {
      return true;
    }

    // Documentation 2001:db8::/32
    if (w0 === 0x2001 && w1 === 0x0db8) {
      return true;
    }

    // Discard prefix 100::/64
    if (w0 === 0x0100 && w1 === 0 && w2 === 0 && w3 === 0) {
      return true;
    }

    return false;
  }

  return false;
}

/**
 * Asserts that a target URL is safe to fetch:
 * - Scheme must be http: or https:
 * - No credentials
 * - Hostname is not localhost or internal alias
 * - Resolved IPs must not be in private/restricted ranges
 */
export async function assertSafeUrl(
  rawUrl: string,
  options?: {
    allowPrivateNetwork?: boolean;
    dnsLookup?: (hostname: string) => Promise<string[]>;
  },
): Promise<void> {
  if (options?.allowPrivateNetwork) {
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (err) {
    throw new FetchError("INVALID_URL", `Malformed URL: ${rawUrl}`, { rawUrl, cause: String(err) });
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new FetchError(
      "UNSUPPORTED_SCHEME",
      `Protocol '${parsed.protocol}' is not supported. Only http: and https: are allowed.`,
      { rawUrl, protocol: parsed.protocol },
    );
  }

  if (parsed.username || parsed.password) {
    throw new FetchError(
      "CREDENTIALS_DISALLOWED",
      "Credentials in source URLs are prohibited.",
      { rawUrl },
    );
  }

  const hostname = parsed.hostname;
  if (!hostname) {
    throw new FetchError("INVALID_URL", "Hostname cannot be empty", { rawUrl });
  }

  const cleanHost = hostname.replace(/^\[|\]$/g, "").toLowerCase();

  // Known local/internal domain aliases
  if (
    cleanHost === "localhost" ||
    cleanHost.endsWith(".localhost") ||
    cleanHost.endsWith(".local") ||
    cleanHost.endsWith(".internal") ||
    cleanHost.endsWith(".lan") ||
    cleanHost === "0.0.0.0"
  ) {
    throw new FetchError("PRIVATE_NETWORK_DENIED", `Forbidden host or local domain: ${hostname}`, {
      rawUrl,
      hostname,
    });
  }

  // If host is already an IP address
  if (net.isIP(cleanHost)) {
    if (isPrivateOrRestrictedIp(cleanHost)) {
      throw new FetchError("PRIVATE_NETWORK_DENIED", `Direct connection to restricted IP denied: ${cleanHost}`, {
        rawUrl,
        ip: cleanHost,
      });
    }
    return;
  }

  // Resolve hostname via DNS
  let ipAddresses: string[] = [];
  if (options?.dnsLookup) {
    ipAddresses = await options.dnsLookup(cleanHost);
  } else {
    try {
      const records = await dns.lookup(cleanHost, { all: true });
      ipAddresses = records.map((r) => r.address);
    } catch (err) {
      throw new FetchError("FETCH_FAILED", `DNS resolution failed for host: ${cleanHost}`, {
        rawUrl,
        hostname: cleanHost,
        cause: String(err),
      });
    }
  }

  if (ipAddresses.length === 0) {
    throw new FetchError("FETCH_FAILED", `No IP addresses found for host: ${cleanHost}`, {
      rawUrl,
      hostname: cleanHost,
    });
  }

  for (const ip of ipAddresses) {
    if (isPrivateOrRestrictedIp(ip)) {
      throw new FetchError("PRIVATE_NETWORK_DENIED", `Host '${cleanHost}' resolved to restricted IP: ${ip}`, {
        rawUrl,
        hostname: cleanHost,
        resolvedIp: ip,
      });
    }
  }
}

/**
 * FetcherService implementing FetcherPort.
 */
export class FetcherService implements FetcherPort {
  private defaultOptions: FetchOptions;

  constructor(options?: FetchOptions) {
    this.defaultOptions = options || {};
  }

  /**
   * Primary FetcherPort entrypoint.
   */
  async fetch(spec: SourceSpec, options?: PortOptions): Promise<DocumentRevision> {
    return this.fetchSource(spec, undefined, { ...this.defaultOptions, ...options });
  }

  /**
   * Fetches an external source with previous revision comparison and failure preservation.
   */
  async fetchSource(
    source: SourceSpec,
    previousRevision?: DocumentRevision,
    options?: FetchOptions,
  ): Promise<DocumentRevision> {
    const opts: FetchOptions = { ...this.defaultOptions, ...options };

    return withPortTimeout(async (signal) => {
      const callOpts = { ...opts, signal };

      switch (source.kind) {
        case "github-repo":
          return GitHubConnector.fetchRepo(source, previousRevision, callOpts);
        case "github-stars":
          return GitHubConnector.fetchStars(source, previousRevision, callOpts);
        case "web":
          return WebConnector.fetchPage(source, previousRevision, callOpts);
        default:
          throw new IntakeError("INVALID_SOURCE_SPEC", `Unsupported source kind: ${(source as any).kind}`);
      }
    }, opts);
  }
}
