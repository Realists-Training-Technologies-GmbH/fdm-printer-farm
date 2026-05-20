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
  version: Pick<VersionDto, "text" | "hostname"> | null | undefined,
): PrusaLinkModelInfo {
  const raw = version?.text ?? null;
  const haystack = `${version?.text ?? ""} ${version?.hostname ?? ""}`.toUpperCase();

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
