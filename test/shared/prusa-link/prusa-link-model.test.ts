import {
  arePrusaModelsCompatible,
  getPrusaPrinterFamily,
  parsePrusaLinkModel,
} from "@/services/prusa-link/utils/prusa-link-model.util";

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

describe("getPrusaPrinterFamily", () => {
  it("groups MK4 and MK4S into the MK4 family", () => {
    expect(getPrusaPrinterFamily("MK4")).toBe("MK4");
    expect(getPrusaPrinterFamily("MK4S")).toBe("MK4");
  });

  it("groups MINI / MINI+ / MINIIS into the MINI family", () => {
    expect(getPrusaPrinterFamily("MINI")).toBe("MINI");
    expect(getPrusaPrinterFamily("MINI+")).toBe("MINI");
    expect(getPrusaPrinterFamily("MINIIS")).toBe("MINI");
    expect(getPrusaPrinterFamily("Original Prusa MINI+")).toBe("MINI");
  });

  it("groups any XL variant into XL", () => {
    expect(getPrusaPrinterFamily("XL")).toBe("XL");
    expect(getPrusaPrinterFamily("XL5")).toBe("XL");
    expect(getPrusaPrinterFamily("Original Prusa XL 5 Toolheads")).toBe("XL");
  });

  it("separates MK3.5 / MK3.9 / MK3 (legacy) into distinct families", () => {
    expect(getPrusaPrinterFamily("MK3.5")).toBe("MK3.5");
    expect(getPrusaPrinterFamily("MK3.5S")).toBe("MK3.5");
    expect(getPrusaPrinterFamily("MK3.9")).toBe("MK3.9");
    expect(getPrusaPrinterFamily("MK3.9S")).toBe("MK3.9");
    expect(getPrusaPrinterFamily("MK3S+")).toBe("MK3");
    expect(getPrusaPrinterFamily("MK3")).toBe("MK3");
  });

  it("normalises Core One", () => {
    expect(getPrusaPrinterFamily("Core One")).toBe("CORE_ONE");
    expect(getPrusaPrinterFamily("COREONE")).toBe("CORE_ONE");
  });

  it("returns null for unrecognised input", () => {
    expect(getPrusaPrinterFamily(null)).toBeNull();
    expect(getPrusaPrinterFamily(undefined)).toBeNull();
    expect(getPrusaPrinterFamily("")).toBeNull();
    expect(getPrusaPrinterFamily("Foobar 9000")).toBeNull();
  });
});

describe("arePrusaModelsCompatible", () => {
  it("MINI-sliced file is rejected for an XL printer (the original bug)", () => {
    expect(arePrusaModelsCompatible("MINI", "XL")).toBe(false);
    expect(arePrusaModelsCompatible("MINI+", "XL")).toBe(false);
  });

  it("MK4-sliced file accepts MK4S printer (same family)", () => {
    expect(arePrusaModelsCompatible("MK4", "MK4S")).toBe(true);
  });

  it("MK3.5 and MK3 are not the same family even if names overlap", () => {
    expect(arePrusaModelsCompatible("MK3.5", "MK3S+")).toBe(false);
    expect(arePrusaModelsCompatible("MK3", "MK3.5")).toBe(false);
  });

  it("fails open when either side is unknown", () => {
    // No slicer model written → don't false-positive
    expect(arePrusaModelsCompatible(null, "XL")).toBe(true);
    // No printer model detected → don't block
    expect(arePrusaModelsCompatible("MINI", null)).toBe(true);
    // Slicer wrote something we don't recognise → don't block
    expect(arePrusaModelsCompatible("Some Future Printer", "XL")).toBe(true);
  });
});
