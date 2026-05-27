import { acceptsExtension, deriveCapabilities } from "@/services/prusa-link/utils/prusa-link-capabilities";
import type { VersionDto } from "@/services/prusa-link/dto/version.dto";

// Mirrors upstream Prusa-Link-Web's per-firmware capability flags, but derived
// at runtime from /api/version. Locks the firmware-divergence decisions
// (bgcode gating + upload transport + accepted extensions) in one place.

function version(over: Partial<VersionDto> = {}): VersionDto {
  return {
    api: "2.0.0",
    server: "2.1.2",
    nozzle_diameter: 0.4,
    text: "PrusaLink",
    hostname: "prusa",
    capabilities: { "upload-by-put": true },
    ...over,
  } as VersionDto;
}

describe("deriveCapabilities", () => {
  it("XL (Buddy): PUT transport, bgcode-capable, accepts .gcode + .bgcode", () => {
    const caps = deriveCapabilities(version({ text: "PrusaLink XL", server: "2.1.2" }));
    expect(caps.model).toBe("XL");
    expect(caps.family).toBe("XL");
    expect(caps.supportsBgcode).toBe(true);
    expect(caps.uploadTransport).toBe("put");
    expect(caps.fileExtensions).toEqual([".gcode", ".bgcode"]);
    expect(caps.serverVersion).toBe("2.1.2");
  });

  it("MK3S (legacy Einsy): legacy multipart transport, no bgcode, .gcode only", () => {
    const caps = deriveCapabilities(version({ text: "PrusaLink", original: "PrusaLink I3MK3S", server: "0.8.1" }));
    expect(caps.family).toBe("MK3");
    expect(caps.supportsBgcode).toBe(false);
    expect(caps.uploadTransport).toBe("legacyMultipart");
    expect(caps.fileExtensions).toEqual([".gcode"]);
  });

  it("legacy Einsy still uses multipart even though it advertises upload-by-put", () => {
    // The MK3 shim lies: upload-by-put=true but the real PUT 500s.
    const caps = deriveCapabilities(version({ original: "PrusaLink MK3S+", capabilities: { "upload-by-put": true } }));
    expect(caps.supportsBgcode).toBe(false);
    expect(caps.uploadTransport).toBe("legacyMultipart");
  });

  it("unknown model fails open: PUT + bgcode allowed", () => {
    const caps = deriveCapabilities(version({ text: "PrusaLink Something-New", original: "", hostname: "" }));
    expect(caps.supportsBgcode).toBeNull();
    expect(caps.uploadTransport).toBe("put");
    expect(caps.fileExtensions).toEqual([".gcode", ".bgcode"]);
  });

  it("reflects the advertised upload-by-put flag", () => {
    expect(deriveCapabilities(version({ capabilities: { "upload-by-put": false } })).uploadByPut).toBe(false);
    expect(deriveCapabilities(version({ capabilities: { "upload-by-put": true } })).uploadByPut).toBe(true);
  });

  it("tolerates a missing/empty version payload", () => {
    const caps = deriveCapabilities(undefined);
    expect(caps.model).toBeNull();
    expect(caps.uploadTransport).toBe("put");
    expect(caps.uploadByPut).toBe(false);
  });
});

describe("acceptsExtension", () => {
  const xl = deriveCapabilities(version({ text: "PrusaLink XL" }));
  const mk3 = deriveCapabilities(version({ original: "PrusaLink MK3S+" }));

  it("XL accepts .gcode and .bgcode (case-insensitive)", () => {
    expect(acceptsExtension(xl, "part.bgcode")).toBe(true);
    expect(acceptsExtension(xl, "PART.BGCODE")).toBe(true);
    expect(acceptsExtension(xl, "part.gcode")).toBe(true);
  });

  it("MK3 rejects .bgcode but accepts .gcode", () => {
    expect(acceptsExtension(mk3, "part.bgcode")).toBe(false);
    expect(acceptsExtension(mk3, "part.gcode")).toBe(true);
  });
});
