import { parsePrusaLinkModel } from "@/services/prusa-link/utils/prusa-link-model.util";

describe("parsePrusaLinkModel", () => {
  it("flags MK4 as bgcode-capable", () => {
    const info = parsePrusaLinkModel({ text: "PrusaLink MK4", hostname: "" });
    expect(info.model).toBe("MK4");
    expect(info.supportsBgcode).toBe(true);
  });

  it("prefers MK4S over MK4 when the longer token is present", () => {
    const info = parsePrusaLinkModel({ text: "PrusaLink MK4S", hostname: "" });
    expect(info.model).toBe("MK4S");
  });

  it("flags MK3S+ as legacy (no bgcode)", () => {
    const info = parsePrusaLinkModel({ text: "PrusaLink MK3S+", hostname: "" });
    expect(info.model).toBe("MK3S+");
    expect(info.supportsBgcode).toBe(false);
  });

  it("prefers MK3S+ over MK3 when both substrings would match", () => {
    const info = parsePrusaLinkModel({ text: "PrusaLink MK3S+", hostname: "" });
    expect(info.model).toBe("MK3S+");
  });

  it("normalises 'Core One' casing", () => {
    const info = parsePrusaLinkModel({ text: "PrusaLink Core One", hostname: "" });
    expect(info.model).toBe("Core One");
    expect(info.supportsBgcode).toBe(true);
  });

  it("falls back to hostname when text doesn't carry the model", () => {
    const info = parsePrusaLinkModel({ text: "PrusaLink", hostname: "XL-001" });
    expect(info.model).toBe("XL");
    expect(info.supportsBgcode).toBe(true);
  });

  it("returns null model on unknown text", () => {
    const info = parsePrusaLinkModel({ text: "PrusaLink Foobar", hostname: "" });
    expect(info.model).toBeNull();
    expect(info.supportsBgcode).toBeNull();
  });

  it("returns null model on missing input", () => {
    expect(parsePrusaLinkModel(null).model).toBeNull();
    expect(parsePrusaLinkModel(undefined).model).toBeNull();
  });
});
