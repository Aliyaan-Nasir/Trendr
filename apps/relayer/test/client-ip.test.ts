import { describe, expect, test } from "bun:test";
import { ipKey, pickClientIp } from "../src/client-ip";

describe("client address", () => {
  test("without trusted proxies it is the socket peer, whatever the header says", () => {
    expect(pickClientIp("6.6.6.6", "203.0.113.7", 0)).toBe("203.0.113.7");
    expect(pickClientIp(undefined, "203.0.113.7", 0)).toBe("203.0.113.7");
    expect(pickClientIp("6.6.6.6", undefined, 0)).toBeUndefined();
  });

  test("behind n proxies it is the entry n places from the right", () => {
    // The client sent "6.6.6.6, 7.7.7.7"; Railway's edge appended the address it saw.
    expect(pickClientIp("6.6.6.6, 7.7.7.7, 203.0.113.7", "10.0.0.2", 1)).toBe("203.0.113.7");
    expect(pickClientIp("203.0.113.7", "10.0.0.2", 1)).toBe("203.0.113.7");
    // Two proxies: a CDN appended the client, then the platform edge appended the CDN.
    expect(pickClientIp("6.6.6.6, 203.0.113.7, 198.51.100.1", "10.0.0.2", 2)).toBe("203.0.113.7");
    expect(pickClientIp(" 203.0.113.7 ,, 198.51.100.1 ", "10.0.0.2", 2)).toBe("203.0.113.7");
  });

  test("with fewer entries than proxies it falls back to the socket peer", () => {
    expect(pickClientIp("6.6.6.6", "10.0.0.2", 2)).toBe("10.0.0.2");
    expect(pickClientIp(undefined, "10.0.0.2", 1)).toBe("10.0.0.2");
    expect(pickClientIp("", "10.0.0.2", 1)).toBe("10.0.0.2");
  });
});

describe("rate-limit key", () => {
  test("keeps IPv4 and drops a port", () => {
    expect(ipKey("203.0.113.7")).toBe("203.0.113.7");
    expect(ipKey(" 203.0.113.7:51234 ")).toBe("203.0.113.7");
  });

  test("groups IPv6 by /64, so rotating the interface part does not help", () => {
    expect(ipKey("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(ipKey("2001:DB8:1:2:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
    expect(ipKey("[2001:db8:1:2::9]:443")).toBe("2001:db8:1:2::/64");
    expect(ipKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipKey("::1")).toBe("0:0:0:0::/64");
    expect(ipKey("fe80::1%en0")).toBe("fe80:0:0:0::/64");
    expect(ipKey("2001:db8:1:3::1")).not.toBe(ipKey("2001:db8:1:2::1"));
  });

  test("reads IPv4-mapped IPv6 as the IPv4 address", () => {
    expect(ipKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(ipKey("::ffff:cb00:7107")).toBe("203.0.113.7");
  });

  test("leaves anything it cannot parse as it is", () => {
    expect(ipKey("not an address")).toBe("not an address");
    expect(ipKey("1:2:3:4:5:6:7:8:9")).toBe("1:2:3:4:5:6:7:8:9");
    expect(ipKey("1::2::3")).toBe("1::2::3");
  });
});
