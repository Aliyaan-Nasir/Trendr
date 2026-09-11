/**
 * The caller's address for rate limits. X-Forwarded-For is only as trustworthy as the proxies that
 * append to it: each proxy adds the address it saw on the right, and everything to the left of the
 * nearest trusted proxy's entry is whatever the client sent. With `trustedHops` proxies in front
 * (Railway's edge is one), the caller is the entry that many positions from the right; with none,
 * it is the socket peer and the header is ignored.
 */
export function pickClientIp(forwardedFor: string | undefined, socket: string | undefined, trustedHops: number): string | undefined {
  if (trustedHops > 0 && forwardedFor) {
    const entries = forwardedFor
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    // Fewer entries than proxies: the request did not come through them, so the header is the
    // client's own and the socket peer is all there is to go on.
    if (entries.length >= trustedHops) return entries[entries.length - trustedHops];
  }
  return socket;
}

/**
 * Rate-limit key for an address: IPv4 as is, IPv6 by its /64 (one subscriber usually holds a whole
 * /64, so single addresses would be free to rotate), IPv4-mapped IPv6 as the IPv4 address.
 */
export function ipKey(raw: string): string {
  const ip = stripPort(raw.trim().toLowerCase());
  if (!ip.includes(":")) return ip;
  const groups = ipv6Groups(ip);
  if (!groups) return ip;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return `${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`;
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":")}::/64`;
}

/** "[::1]:443" to "::1", "1.2.3.4:80" to "1.2.3.4"; a bare IPv6 address is left alone. */
function stripPort(ip: string): string {
  const bracketed = ip.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) return bracketed[1]!;
  const v4 = ip.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  return v4 ? v4[1]! : ip;
}

/** The eight 16-bit groups of an IPv6 address, or null when it does not parse. */
function ipv6Groups(ip: string): number[] | null {
  let text = ip.split("%")[0]!;
  // A trailing dotted IPv4 part stands for the last two groups.
  const v4 = text.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const b = v4.slice(2).map(Number);
    if (b.some((x) => x > 255)) return null;
    text = `${v4[1]}${((b[0]! << 8) | b[1]!).toString(16)}:${((b[2]! << 8) | b[3]!).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string) => (s === "" ? [] : s.split(":"));
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : null;
  let parts: string[];
  if (tail === null) {
    parts = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    parts = [...head, ...Array<string>(missing).fill("0"), ...tail];
  }
  if (parts.length !== 8 || !parts.every((p) => /^[0-9a-f]{1,4}$/.test(p))) return null;
  return parts.map((p) => parseInt(p, 16));
}
