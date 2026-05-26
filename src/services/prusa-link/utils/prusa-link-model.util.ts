import type { VersionDto } from "@/services/prusa-link/dto/version.dto";

/**
 * Identifying info parsed from a PrusaLink `/api/version` response.
 *
 *   - `model`         normalized model token, e.g. "MK4", "MK4S", "MK3.9",
 *                     "MK3.5", "XL", "MINI", "Core One", "MK3S", "MK3".
 *                     `null` when nothing recognisable could be extracted.
 *   - `supportsBgcode` whether the firmware on this board can decode Prusa
 *                     binary G-code (`.bgcode`). True for 32-bit Buddy boards
 *                     (MK4, MK3.9, MK3.5, XL, MINI/MINI+, Core One), false for
 *                     legacy 8-bit Einsy boards (MK2.x, MK3, MK3S, MK3S+).
 *                     `null` when we couldn't classify the model.
 *   - `raw`           original `text` field from the version payload, kept
 *                     for diagnostics and logging.
 */
export interface PrusaLinkModelInfo {
  model: string | null;
  supportsBgcode: boolean | null;
  raw: string | null;
}

// Models known to run Buddy firmware on a 32-bit board — they natively
// decode `.bgcode`.
const BGCODE_CAPABLE = ["MK4S", "MK4", "MK3.9S", "MK3.9", "MK3.5S", "MK3.5", "XL", "MINI+", "MINI", "CORE ONE"];

// Models that run Marlin on an 8-bit Einsy board, even when reached through
// PrusaLink (the Pi is a thin shim, not the printer brain). These cannot
// decode `.bgcode`.
const LEGACY_NO_BGCODE = ["MK3S+", "MK3S", "MK3", "MK2.5S", "MK2.5"];

/**
 * Parse model and bgcode capability from a PrusaLink `/api/version` payload.
 *
 * PrusaLink exposes the model inside the `text` field (e.g. "PrusaLink MK4S",
 * "PrusaLink XL", "PrusaLink MK3S+", "PrusaLink MINI"). We strip the
 * "PrusaLink " prefix and then match against the known catalogues above.
 *
 * Returns a best-effort classification — when nothing matches we return
 * `model: null, supportsBgcode: null` so callers can decide whether to fail
 * open or closed.
 */
export function parsePrusaLinkModel(
  version: Pick<VersionDto, "text" | "hostname" | "original"> | null | undefined,
): PrusaLinkModelInfo {
  const raw = version?.text ?? null;
  // Legacy MK3/MK2.5 put the model in `original` ("PrusaLink I3MK3S") and only
  // a version string in `text`, so search all three fields.
  const haystack = `${version?.text ?? ""} ${version?.original ?? ""} ${version?.hostname ?? ""}`.toUpperCase();

  if (!haystack.trim()) {
    return { model: null, supportsBgcode: null, raw };
  }

  // Match longest token first so "MK3S+" beats "MK3", "MK4S" beats "MK4".
  for (const candidate of BGCODE_CAPABLE) {
    if (haystack.includes(candidate)) {
      return { model: normalizeModelCasing(candidate), supportsBgcode: true, raw };
    }
  }
  for (const candidate of LEGACY_NO_BGCODE) {
    if (haystack.includes(candidate)) {
      return { model: normalizeModelCasing(candidate), supportsBgcode: false, raw };
    }
  }

  return { model: null, supportsBgcode: null, raw };
}

function normalizeModelCasing(upper: string): string {
  if (upper === "CORE ONE") return "Core One";
  return upper;
}

/**
 * Map any printer model string (firmware-reported or slicer-written) to a
 * coarse "family" token. Two printers belong to the same family if they can
 * print the same gcode without re-slicing — same kinematics, same build
 * volume class, same firmware lineage.
 *
 * Returns `null` when the input has no recognisable family token; callers
 * should treat that as "unknown, fail open".
 *
 * Families:
 *   - "MK4"      — MK4, MK4S
 *   - "MK3.9"    — MK3.9, MK3.9S (Buddy upgrade kit on MK3 frame)
 *   - "MK3.5"    — MK3.5, MK3.5S
 *   - "XL"       — XL (any tool count)
 *   - "MINI"     — MINI, MINI+, MINIIS
 *   - "CORE_ONE" — Core One
 *   - "MK3"      — MK3S+, MK3S, MK3 (legacy 8-bit Einsy board)
 *   - "MK2"      — MK2.5S, MK2.5, MK2S, MK2 (legacy)
 */
export function getPrusaPrinterFamily(model: string | null | undefined): string | null {
  if (!model) return null;
  const upper = model.toUpperCase().trim();
  if (upper.includes("CORE ONE") || upper.includes("COREONE")) return "CORE_ONE";
  if (upper.includes("XL")) return "XL";
  // Buddy upgrade variants live on their own family — same gcode envelope but
  // different motion/heat profiles than plain MK4/MK3 frames.
  if (upper.includes("MK3.9")) return "MK3.9";
  if (upper.includes("MK3.5")) return "MK3.5";
  if (upper.includes("MK4")) return "MK4";
  if (upper.includes("MINI")) return "MINI";
  if (upper.includes("MK3")) return "MK3";
  if (upper.includes("MK2")) return "MK2";
  return null;
}

/**
 * Decide whether a file sliced for `fileModel` can be sent to a printer
 * identified as `printerModel`. Fails open (returns `true`) whenever either
 * side is unknown — better than blocking the user when we have no signal.
 */
export function arePrusaModelsCompatible(
  fileModel: string | null | undefined,
  printerModel: string | null | undefined,
): boolean {
  const fileFamily = getPrusaPrinterFamily(fileModel);
  const printerFamily = getPrusaPrinterFamily(printerModel);
  if (!fileFamily || !printerFamily) return true;
  return fileFamily === printerFamily;
}
