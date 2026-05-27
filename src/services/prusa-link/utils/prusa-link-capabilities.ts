import type { VersionDto } from "@/services/prusa-link/dto/version.dto";
import { getPrusaPrinterFamily, parsePrusaLinkModel } from "@/services/prusa-link/utils/prusa-link-model.util";

/**
 * Runtime-derived capability profile for a PrusaLink printer.
 *
 * Upstream Prusa-Link-Web models each firmware variant as a flat set of
 * build-time flags (config.mini.js / config.m1.js over webpack.config.js:
 * `FILE_EXTENSIONS`, `WITH_STORAGES`, `WITH_V1_API`, `WITH_API_KEY_AUTH`, …).
 * We can't pick a profile at build time because we talk to arbitrary printers,
 * so we derive the equivalent capabilities at runtime from `/api/version`
 * (printer model + the advertised `capabilities.upload-by-put`).
 *
 * This centralises the firmware divergences that today live as scattered `if`s
 * across the adapter (bgcode gating in `uploadFile`, PUT-vs-legacy upload
 * transport, accepted file extensions, …) into one explicit object, so each
 * method can ask "what can THIS printer do" instead of re-deriving it.
 *
 * Capabilities that can only be known by talking to the printer at runtime
 * (the internal print storage segment, whether cameras are wired) are NOT
 * modelled here — they're probed where needed (`getInternalStorage`,
 * `listCameras`). This object is purely the `/api/version`-derivable surface.
 */
export interface PrusaLinkCapabilities {
  /** Normalised model token, e.g. "XL", "MK4S", "MK3S+". `null` if unknown. */
  model: string | null;
  /** Coarse model family ("XL", "MK4", "MK3", …). `null` if unknown. */
  family: string | null;
  /**
   * Whether the board can decode Prusa binary G-code. `true` for 32-bit Buddy
   * boards, `false` for legacy 8-bit Einsy, `null` when the model is unknown
   * (callers fail open — see `acceptsExtension`).
   */
  supportsBgcode: boolean | null;
  /** The `capabilities.upload-by-put` flag the firmware advertised. */
  uploadByPut: boolean;
  /**
   * Transport `uploadFile` should use:
   *   - "put"            modern raw octet-stream PUT to /api/v1/files/...
   *   - "legacyMultipart" OctoPrint-compat multipart POST /api/files/{storage}
   * Legacy Einsy boards advertise upload-by-put but 500 on the real PUT, so
   * they must use multipart. This mirrors today's `useLegacyMultipart`
   * (`supportsBgcode === false`) decision exactly.
   */
  uploadTransport: "put" | "legacyMultipart";
  /** Upload extensions the firmware accepts (upstream `FILE_EXTENSIONS`). */
  fileExtensions: string[];
  /** `version.api` — the PrusaLink Web API version string. */
  apiVersion: string | null;
  /** `version.server` — the PrusaLink server version string. */
  serverVersion: string | null;
  /** Raw `version.text` (e.g. "PrusaLink XL"), kept for diagnostics/errors. */
  versionText: string | null;
}

/**
 * Derive the capability profile from a `/api/version` payload. Pure and
 * side-effect free so it can be memoised by the caller (a printer's firmware
 * doesn't change between requests).
 *
 * Behaviour-preserving by construction: `supportsBgcode`,
 * `uploadTransport`, and the bgcode extension gate reproduce the decisions the
 * adapter makes today, just expressed in one place.
 */
export function deriveCapabilities(version: VersionDto | null | undefined): PrusaLinkCapabilities {
  const modelInfo = parsePrusaLinkModel(version);
  const family = getPrusaPrinterFamily(modelInfo.model);
  const uploadByPut = version?.capabilities?.["upload-by-put"] ?? false;

  // Einsy (supportsBgcode === false) must use the legacy multipart POST: it
  // advertises upload-by-put but 500s on the modern PUT. Everything else
  // (Buddy, or unknown) uses PUT — the method keeps its own runtime 5xx→legacy
  // fallback for surprises, so this stays safe for firmwares we can't classify.
  const uploadTransport: PrusaLinkCapabilities["uploadTransport"] =
    modelInfo.supportsBgcode === false ? "legacyMultipart" : "put";

  // Accept .bgcode unless we positively know the board can't decode it
  // (fail open on unknown — matches today's `supportsBgcode === false` gate).
  const fileExtensions = modelInfo.supportsBgcode === false ? [".gcode"] : [".gcode", ".bgcode"];

  return {
    model: modelInfo.model,
    family,
    supportsBgcode: modelInfo.supportsBgcode,
    uploadByPut,
    uploadTransport,
    fileExtensions,
    apiVersion: version?.api ?? null,
    serverVersion: version?.server ?? null,
    versionText: modelInfo.raw,
  };
}

/**
 * Whether a filename's extension is accepted for upload on this printer.
 * Case-insensitive. Fails open for unknown models (bgcode allowed).
 */
export function acceptsExtension(caps: PrusaLinkCapabilities, fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return caps.fileExtensions.some((ext) => lower.endsWith(ext));
}
