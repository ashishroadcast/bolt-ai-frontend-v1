import { describe, expect, it } from "vitest";
import { decodeExpiry } from "./jwt.ts";

function fakeJwt(payload: Record<string, unknown>): string {
  const base64url = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${base64url({ alg: "HS256", typ: "JWT" })}.${base64url(payload)}.signature-not-checked`;
}

describe("decodeExpiry", () => {
  it("reads the exp claim as milliseconds", () => {
    const expSeconds = 1_800_000_000;
    const token = fakeJwt({ user_id: 1, exp: expSeconds });
    expect(decodeExpiry(token)).toBe(expSeconds * 1000);
  });

  it("returns null when the token has no exp claim", () => {
    const token = fakeJwt({ user_id: 1 });
    expect(decodeExpiry(token)).toBeNull();
  });

  it("returns null for a malformed token rather than throwing", () => {
    expect(decodeExpiry("not-a-jwt")).toBeNull();
    expect(decodeExpiry("only.two")).toBeNull();
    expect(decodeExpiry("a.b.c.d")).toBeNull();
  });

  it("returns null when the payload segment is not valid base64/JSON", () => {
    expect(decodeExpiry("a.!!!not-base64!!!.c")).toBeNull();
  });
});
