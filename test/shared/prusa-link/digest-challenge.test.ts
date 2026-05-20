import { parseDigestChallenge } from "@/services/prusa-link/utils/prusa-link-http-client.builder";

describe("parseDigestChallenge", () => {
  it("parses a typical PrusaLink challenge", () => {
    const header = 'realm="Printer API", nonce="abc123", qop="auth"';
    const parsed = parseDigestChallenge(header);
    expect(parsed.realm).toBe("Printer API");
    expect(parsed.nonce).toBe("abc123");
    expect(parsed.qop).toBe("auth");
  });

  it("handles base64-padded nonces (contain '=')", () => {
    const header = 'realm="Printer API", nonce="MTcwOTAwMA==", qop="auth"';
    const parsed = parseDigestChallenge(header);
    expect(parsed.nonce).toBe("MTcwOTAwMA==");
  });

  it("preserves comma-separated qop values inside quotes", () => {
    const header = 'realm="r", nonce="n", qop="auth,auth-int"';
    const parsed = parseDigestChallenge(header);
    expect(parsed.qop).toBe("auth,auth-int");
  });

  it("survives missing space after commas", () => {
    const header = 'realm="r",nonce="n",qop="auth"';
    const parsed = parseDigestChallenge(header);
    expect(parsed.nonce).toBe("n");
    expect(parsed.qop).toBe("auth");
  });

  it("handles unquoted values like stale=true and algorithm=MD5", () => {
    const header = 'realm="r", nonce="n", stale=true, algorithm=MD5';
    const parsed = parseDigestChallenge(header);
    expect(parsed.stale).toBe("true");
    expect(parsed.algorithm).toBe("MD5");
  });

  it("lower-cases keys for case-insensitive lookups", () => {
    const header = 'Realm="r", NONCE="n", Qop="auth"';
    const parsed = parseDigestChallenge(header);
    expect(parsed.realm).toBe("r");
    expect(parsed.nonce).toBe("n");
    expect(parsed.qop).toBe("auth");
  });

  it("returns empty object on empty input", () => {
    expect(parseDigestChallenge("")).toEqual({});
  });
});
