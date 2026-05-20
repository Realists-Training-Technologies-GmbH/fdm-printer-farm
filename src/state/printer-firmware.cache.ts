import type { ILoggerFactory } from "@/handlers/logger-factory";
import { LoggerService } from "@/handlers/logger";
import { PrinterApiFactory } from "@/services/printer-api.factory";
import { PrusaLinkType } from "@/services/printer-api.interface";
import { PrinterCache } from "@/state/printer.cache";
import { parsePrusaLinkModel, type PrusaLinkModelInfo } from "@/services/prusa-link/utils/prusa-link-model.util";
import { PrusaLinkApi } from "@/services/prusa-link/prusa-link.api";
import { printerEvents, type PrinterCreatedEvent, type PrintersDeletedEvent } from "@/constants/event.constants";
import EventEmitter2 from "eventemitter2";
import { errorSummary } from "@/utils/error.utils";

interface CachedFirmwareEntry {
  info: PrusaLinkModelInfo;
  fetchedAt: number;
  /** Resolves to the in-flight info promise so concurrent lookups share work. */
  inFlight?: Promise<PrusaLinkModelInfo>;
}

const TTL_MS = 60 * 60 * 1000; // 1h — model doesn't change without a deliberate user action
const FETCH_TIMEOUT_MS = 2_500;

/**
 * Caches per-printer firmware info we use to make compatibility decisions
 * (today: only the PrusaLink model so we can tell MK4/XL — which support
 * `.bgcode` — from MK3/MK3S — which do not).
 *
 * Entries are populated lazily on demand. `listAllFiles`-style callers should
 * use {@link getCachedInfoSync} to read whatever is already cached and avoid
 * stalling the request on N network calls; `getOrFetch` is the awaitable
 * version for single-printer paths.
 */
export class PrinterFirmwareCache {
  private readonly logger: LoggerService;
  private readonly entries = new Map<number, CachedFirmwareEntry>();

  constructor(
    loggerFactory: ILoggerFactory,
    private readonly printerCache: PrinterCache,
    private readonly printerApiFactory: PrinterApiFactory,
    eventEmitter2: EventEmitter2,
  ) {
    this.logger = loggerFactory(PrinterFirmwareCache.name);

    eventEmitter2.on(printerEvents.printerUpdated, this.handlePrinterChanged.bind(this));
    eventEmitter2.on(printerEvents.printerCreated, this.handlePrinterChanged.bind(this));
    eventEmitter2.on(printerEvents.printersDeleted, this.handlePrintersDeleted.bind(this));
  }

  /**
   * Return whatever's already cached for the printer without making a network
   * call. Use in hot paths like compatibility listings.
   */
  getCachedInfoSync(printerId: number): PrusaLinkModelInfo | null {
    const entry = this.entries.get(printerId);
    if (!entry) return null;
    if (Date.now() - entry.fetchedAt > TTL_MS) return null;
    return entry.info;
  }

  /**
   * Return cached info if fresh, otherwise fetch from the printer. Falls back
   * to `{ model: null, supportsBgcode: null }` on any error (network down,
   * timeout, auth failure) — callers decide whether to fail open or closed.
   */
  async getOrFetch(printerId: number): Promise<PrusaLinkModelInfo> {
    const cached = this.entries.get(printerId);
    const fresh = cached && Date.now() - cached.fetchedAt <= TTL_MS;

    if (fresh) return cached!.info;
    if (cached?.inFlight) return cached.inFlight;

    const promise = this.fetchFromPrinter(printerId)
      .then((info) => {
        this.entries.set(printerId, { info, fetchedAt: Date.now() });
        return info;
      })
      .catch((error) => {
        this.logger.debug(`Firmware fetch failed for printer ${printerId}: ${errorSummary(error)}`);
        const fallback: PrusaLinkModelInfo = { model: null, supportsBgcode: null, raw: null };
        // Cache the failure briefly so a wave of compatibility lookups doesn't
        // hammer an unreachable printer.
        this.entries.set(printerId, { info: fallback, fetchedAt: Date.now() });
        return fallback;
      });

    // Stash the in-flight promise so concurrent callers don't double-fetch.
    this.entries.set(printerId, {
      info: cached?.info ?? { model: null, supportsBgcode: null, raw: null },
      fetchedAt: cached?.fetchedAt ?? 0,
      inFlight: promise,
    });

    return promise;
  }

  /** Drop the entry for a printer; used on update/delete. */
  invalidate(printerId: number): void {
    this.entries.delete(printerId);
  }

  private async fetchFromPrinter(printerId: number): Promise<PrusaLinkModelInfo> {
    const printer = await this.printerCache.getCachedPrinterOrThrowAsync(printerId);
    if (printer.printerType !== PrusaLinkType) {
      // Non-PrusaLink printers don't need a model lookup for our purposes.
      return { model: null, supportsBgcode: null, raw: null };
    }
    if (!printer.enabled) {
      return { model: null, supportsBgcode: null, raw: null };
    }

    const api = this.printerApiFactory.getById(printerId) as PrusaLinkApi;
    const version = await withTimeout(api.getVersionInfo(), FETCH_TIMEOUT_MS);
    return parsePrusaLinkModel(version);
  }

  private handlePrinterChanged(event: PrinterCreatedEvent): void {
    if (event?.printer?.id != null) {
      this.invalidate(event.printer.id);
    }
  }

  private handlePrintersDeleted(event: PrintersDeletedEvent): void {
    for (const id of event.printerIds ?? []) {
      this.invalidate(id);
    }
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Firmware fetch timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
