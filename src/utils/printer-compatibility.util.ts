import {
  BambuType,
  MoonrakerType,
  OctoprintType,
  type PrinterType,
  PrusaLinkType,
} from "@/services/printer-api.interface";
import type { FileFormatType } from "@/entities/print-job.entity";

/**
 * Compatibility matrix between file formats and printer types.
 *
 *   - `.gcode`  : plain text G-code. Supported by OctoPrint, Moonraker (Klipper),
 *                 and PrusaLink (Buddy firmware).
 *   - `.bgcode` : Prusa binary G-code, only consumed by PrusaLink-flashed
 *                 firmware (MK4, MK3.9, XL, MINI+, Core One).
 *   - `.3mf`    : Bambu uses 3MF (with embedded G-code) as its native print
 *                 format. Other printer types do not accept 3MF directly.
 */
const COMPATIBILITY: Record<FileFormatType, ReadonlyArray<PrinterType>> = {
  gcode: [OctoprintType, MoonrakerType, PrusaLinkType],
  bgcode: [PrusaLinkType],
  "3mf": [BambuType],
};

const PRINTER_TYPE_LABEL: Record<PrinterType, string> = {
  [OctoprintType]: "OctoPrint",
  [MoonrakerType]: "Moonraker",
  [PrusaLinkType]: "PrusaLink",
  [BambuType]: "Bambu",
};

/**
 * Returns `true` when a printer of `printerType` is able to print a file of
 * `fileFormat`.
 */
export function isPrinterCompatibleWithFileFormat(
  printerType: PrinterType,
  fileFormat: FileFormatType | string | null | undefined,
): boolean {
  if (!fileFormat) return false;

  const allowed = COMPATIBILITY[fileFormat as FileFormatType];
  if (!allowed) return false;

  return allowed.includes(printerType);
}

/**
 * Returns a human-readable explanation when a printer and a file format are
 * incompatible, or `null` when they are compatible.
 */
export function getIncompatibilityReason(
  printerType: PrinterType,
  fileFormat: FileFormatType | string | null | undefined,
): string | null {
  if (!fileFormat) {
    return "File format is unknown — analyze the file before assigning it to a printer.";
  }

  if (!(fileFormat in COMPATIBILITY)) {
    return `Unsupported file format "${fileFormat}".`;
  }

  if (isPrinterCompatibleWithFileFormat(printerType, fileFormat)) {
    return null;
  }

  const accepted = COMPATIBILITY[fileFormat as FileFormatType].map((t) => PRINTER_TYPE_LABEL[t]).join(", ");
  const printerLabel = PRINTER_TYPE_LABEL[printerType] ?? `type ${printerType}`;
  return `Files in "${fileFormat}" format cannot be printed on a ${printerLabel} printer. Compatible printer types: ${accepted}.`;
}

/**
 * Returns the printer types able to accept a given file format.
 */
export function getCompatiblePrinterTypes(
  fileFormat: FileFormatType | string | null | undefined,
): ReadonlyArray<PrinterType> {
  if (!fileFormat) return [];
  return COMPATIBILITY[fileFormat as FileFormatType] ?? [];
}

/**
 * Returns the file formats a printer type can natively accept.
 */
export function getCompatibleFileFormats(printerType: PrinterType): FileFormatType[] {
  return (Object.keys(COMPATIBILITY) as FileFormatType[]).filter((fmt) => COMPATIBILITY[fmt].includes(printerType));
}

export { PRINTER_TYPE_LABEL };
