import { describe, expect, test } from "bun:test";
import { rotationReader } from "../src/rotation";

describe("rotation reader", () => {
  test("reads the rotating list, at most once a minute, and keeps it through a failed read", async () => {
    let t = 0;
    let calls = 0;
    let fail = false;
    const fetchImpl = (async () => {
      calls++;
      if (fail) throw new Error("down");
      return new Response(JSON.stringify({ rotating: ["topic:faded.2", 7] }));
    }) as unknown as typeof fetch;
    const read = rotationReader("https://api.example/v1/rotation", fetchImpl, () => t);
    expect([...(await read())]).toEqual(["topic:faded.2"]);
    t += 30_000;
    await read();
    expect(calls).toBe(1);
    t += 31_000;
    fail = true;
    expect([...(await read())]).toEqual(["topic:faded.2"]);
    expect(calls).toBe(2);
  });
});
