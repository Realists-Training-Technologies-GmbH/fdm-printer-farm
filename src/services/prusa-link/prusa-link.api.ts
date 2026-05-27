import { HttpClientFactory } from "@/services/core/http-client.factory";
import { LoggerService } from "@/handlers/logger";
import type { ILoggerFactory } from "@/handlers/logger-factory";
import {
  FileDto,
  IPrinterApi,
  PartialReprintFileDto,
  PrinterType,
  PrusaLinkType,
  ReprintState,
  UploadFileInput,
  uploadFileInputSchema,
} from "@/services/printer-api.interface";
import { AxiosError, AxiosPromise } from "axios";
import FormData from "form-data";
import type { LoginDto } from "../interfaces/login.dto";
import type { ServerConfigDto } from "../moonraker/dto/server/server-config.dto";
import type { SettingsDto } from "../octoprint/dto/settings/settings.dto";
import { PrusaLinkHttpClientBuilder } from "@/services/prusa-link/utils/prusa-link-http-client.builder";
import type { VersionDto } from "@/services/prusa-link/dto/version.dto";
import type { PL_StatusDto, PL_StorageDto } from "@/services/prusa-link/dto/status.dto";
import type { PL_PrinterStateDto } from "@/services/prusa-link/dto/printer-state.dto";
import type { PL_JobStateDto } from "@/services/prusa-link/dto/job-state.dto";
import { uploadDoneEvent, uploadFailedEvent, uploadProgressEvent } from "@/constants/event.constants";
import { ExternalServiceError } from "@/exceptions/runtime.exceptions";
import EventEmitter2 from "eventemitter2";
import type { PL_FileDto } from "@/services/prusa-link/dto/file.dto";
import { SettingsStore } from "@/state/settings.store";
import { deriveCapabilities, type PrusaLinkCapabilities } from "@/services/prusa-link/utils/prusa-link-capabilities";
import { apiKeyHeaderKey } from "@/services/octoprint/constants/octoprint-service.constants";

const defaultLog = { adapter: "prusa-link" };

/**
 * Prusa Link OpenAPI spec https://raw.githubusercontent.com/prusa3d/Prusa-Link-Web/master/spec/openapi.yaml
 * Prusa Link https://github.com/prusa3d/Prusa-Link
 * Prusa Link Web https://github.com/prusa3d/Prusa-Link-Web/tree/master
 */
export class PrusaLinkApi implements IPrinterApi {
  protected logger: LoggerService;
  private authHeader: string | null = null;
  // Memoized "internal printing storage" segment (see getInternalStorage).
  // A printer's storage layout is fixed, so resolve it once per instance.
  private internalStorageSegment: string | null = null;
  // Memoized capability profile (see getCapabilities). Derived from
  // /api/version, which doesn't change for a given printer/firmware.
  private capabilities: PrusaLinkCapabilities | null = null;

  constructor(
    loggerFactory: ILoggerFactory,
    private readonly eventEmitter2: EventEmitter2,
    private readonly httpClientFactory: HttpClientFactory,
    private readonly settingsStore: SettingsStore,
    private printerLogin: LoginDto,
  ) {
    this.logger = loggerFactory(PrusaLinkApi.name);
    this.logger.debug("Constructed api client", this.logMeta());
  }

  get type(): PrinterType {
    return PrusaLinkType;
  }

  set login(login: LoginDto) {
    this.printerLogin = login;
  }

  // NOTE: a fresh client per request is intentional. This box exposes two
  // digest realms — "Administrator" (MD5-sess, native /api/version &
  // /api/v1/*) and "Printer API" (plain, OctoPrint-compat /api/printer &
  // /api/job). A single reused client can only hold one parsed challenge
  // context, so reusing it across endpoints made requests get signed with
  // the wrong realm and 401. Building per request lets each one run its own
  // 401 → challenge → retry against the realm that endpoint actually uses.
  private get client() {
    return this.createClient();
  }

  async getVersion(): Promise<string> {
    const response = await this.client.get<VersionDto>("/api/version");
    return response.data.server;
  }

  /**
   * Full `/api/version` payload — used to detect the printer model so we can
   * decide whether `.bgcode` is supported (32-bit Buddy boards) or not
   * (legacy 8-bit Einsy boards reached via a PrusaLink shim).
   */
  async getVersionInfo(): Promise<VersionDto> {
    const response = await this.client.get<VersionDto>("/api/version");
    return response.data;
  }

  /**
   * Resolved capability profile for this printer — the single source of truth
   * for the firmware divergences the adapter has to handle (bgcode support,
   * upload transport, accepted file extensions, …). Derived from `/api/version`
   * and memoized per instance, since a printer's firmware doesn't change.
   */
  async getCapabilities(): Promise<PrusaLinkCapabilities> {
    if (this.capabilities) {
      return this.capabilities;
    }
    this.capabilities = deriveCapabilities(await this.getVersionInfo());
    return this.capabilities;
  }

  async validateConnection(): Promise<void> {
    await this.getVersion();
  }

  async getFiles(recursive = false, startDir = "") {
    if (recursive) {
      throw new ExternalServiceError(
        {
          error: "Recursive file listing isn't supported on PrusaLink — walk one folder at a time.",
          statusCode: 501,
          success: false,
        },
        "Prusa-Link",
      );
    }

    // Use the modern PrusaLink endpoint `/api/v1/files/{storage}/{...path}`.
    // The legacy `/api/files` endpoint (OctoPrint-compat) is unreliable — on
    // Buddy firmware it intermittently reports `children: []` for the USB folder
    // even when files are physically present on the stick.
    //
    // `startDir` may arrive as "/usb", "/usb/", "usb/Produktion",
    // "Produktion/SubFolder", etc. Segments are user-facing (`display_name`),
    // not the FAT 8.3 short names PrusaLink stores them under, so we resolve
    // each segment back to its short name before talking to the firmware.
    const trimmed = (startDir ?? "").replace(/^\/+|\/+$/g, "");
    const storageMatch = trimmed.match(/^(usb|local|sdcard)(?:\/(.+))?$/i);
    // When startDir names a storage explicitly use it. Otherwise list the
    // internal printing storage (usb on Buddy, local on Einsy) instead of
    // assuming "usb", which 404s on MK3/MK2.5.
    const storage = storageMatch ? storageMatch[1].toLowerCase() : await this.getInternalStorage();
    const relPath = storageMatch ? (storageMatch[2] ?? "") : trimmed;

    // Try the path as-is (LFN) first — see `resolveEncodedPath` for the rationale.
    type ListingResponse = {
      name?: string;
      type?: string;
      children?: Array<{
        name: string;
        display_name?: string;
        type?: string;
        size?: number;
        m_timestamp?: number;
        refs?: { download?: string };
      }>;
    };

    const encodeSegments = (p: string) => p.split("/").filter(Boolean).map(encodeURIComponent).join("/");

    // Paginate through `/api/v1/files/{storage}/{...path}`. The default page
    // size on Buddy firmware is small (10 items) and the firmware caps the
    // upper limit, so we walk offsets in `pageSize` chunks until a short page
    // arrives — that's how PrusaLink signals end-of-listing. The hard cap
    // protects against pathological cases (corrupt FAT entries looping).
    const pageSize = 200;
    const maxItems = 10_000;
    const buildUrl = (encoded: string, offset: number) => {
      const query = `?offset=${offset}&limit=${pageSize}`;
      return encoded ? `/api/v1/files/${storage}/${encoded}${query}` : `/api/v1/files/${storage}${query}`;
    };

    const fetchAll = async (encoded: string): Promise<ListingResponse> => {
      const accumulated: NonNullable<ListingResponse["children"]> = [];
      let head: ListingResponse | undefined;
      for (let offset = 0; offset < maxItems; offset += pageSize) {
        const page = await this.client.get<ListingResponse>(buildUrl(encoded, offset));
        if (!head) head = page.data;
        const slice = page.data?.children ?? [];
        accumulated.push(...slice);
        // Short page → no more items. PrusaLink doesn't expose a total count
        // header, so this is the only reliable end-of-listing signal.
        if (slice.length < pageSize) break;
      }
      return { ...head, children: accumulated };
    };

    const directEncoded = encodeSegments(relPath);
    let response: ListingResponse;
    let resolvedEncodedParent = directEncoded;
    try {
      response = await fetchAll(directEncoded);
    } catch {
      const shortRel = await this.resolveStoragePath(relPath, storage);
      resolvedEncodedParent = encodeSegments(shortRel);
      response = await fetchAll(resolvedEncodedParent);
    }

    const children = response.children ?? [];
    // The user navigated into `relPath` using display names, so build the
    // prefix from those (not the resolved short names) — otherwise a click
    // on `Produktion/subfile` would return as `PRODUK~1/...` and round-trip
    // wouldn't show the long folder name to the user anymore.
    const dirPrefix = relPath ? `${relPath.replace(/\/+$/, "")}/` : "";

    const baseItems = children.map((child) => {
      const dir = (child.type ?? "").toUpperCase() === "FOLDER";
      // Surface the long display name in `path` so the frontend (which
      // renders `path` directly) shows "Produktion" instead of "PRODUK~1".
      // We resolve back to the short name on every operation below.
      const visibleName = child.display_name ?? child.name;
      return {
        path: `${dirPrefix}${visibleName}`,
        size: child.size ?? null,
        date: child.m_timestamp ?? null,
        dir,
        displayName: child.display_name ?? null,
      };
    });

    // PrusaLink's folder listings don't include `size` for child files (only
    // the individual `/api/v1/files/<storage>/<path>` endpoint does). Fetch sizes
    // in parallel for the files that are missing one. Cap to a reasonable
    // batch so a huge folder doesn't fan out into thousands of requests.
    const sizeFetchCap = 64;
    const missingSize = baseItems.filter((i) => !i.dir && i.size === null).slice(0, sizeFetchCap);
    if (missingSize.length > 0) {
      const sizes = await Promise.all(
        children
          .filter((c) => (c.type ?? "").toUpperCase() !== "FOLDER" && c.size == null)
          .slice(0, sizeFetchCap)
          .map((c) => {
            const encodedChild = resolvedEncodedParent
              ? `${resolvedEncodedParent}/${encodeURIComponent(c.name)}`
              : encodeURIComponent(c.name);
            return this.getFileRaw(encodedChild, storage)
              .then((r) => r.data?.size ?? null)
              .catch(() => null);
          }),
      );
      missingSize.forEach((item, idx) => {
        item.size = sizes[idx];
      });
    }

    return {
      dirs: baseItems.filter((i) => i.dir),
      files: baseItems.filter((i) => !i.dir),
    };
  }

  /**
   * Walk a user-facing path (which may contain `display_name` segments like
   * "Produktion/file.bgcode") and resolve it to the printer's actual FAT path
   * (short names like "PRODUK~1/FILE~1.BGC") by listing each parent and
   * matching by `display_name` first, then by `name`.
   *
   * The input may arrive URL-encoded (it does when called from controllers
   * that already encode for the printer API). Each segment is decoded before
   * matching.
   */
  private async resolveStoragePath(userPath: string, storage: string): Promise<string> {
    if (!userPath) return "";
    const segments = userPath
      .split("/")
      .filter(Boolean)
      .map((s) => {
        try {
          return decodeURIComponent(s);
        } catch {
          return s;
        }
      });

    // Walk pages lazily — stop as soon as we find the matching display_name
    // in a parent. This makes deep folder lookups affordable on large USBs
    // without paying for a full enumeration.
    const pageSize = 200;
    const maxItems = 10_000;

    const resolved: string[] = [];
    for (const segment of segments) {
      const parentEncoded = resolved.map(encodeURIComponent).join("/");
      const baseUrl = parentEncoded ? `/api/v1/files/${storage}/${parentEncoded}` : `/api/v1/files/${storage}`;

      let matchName: string | null = null;
      try {
        for (let offset = 0; offset < maxItems; offset += pageSize) {
          const response = await this.client.get<{
            children?: Array<{ name: string; display_name?: string }>;
          }>(`${baseUrl}?offset=${offset}&limit=${pageSize}`);
          const slice = response.data?.children ?? [];
          const hit = slice.find((c) => c.display_name === segment || c.name === segment);
          if (hit) {
            matchName = hit.name;
            break;
          }
          if (slice.length < pageSize) break;
        }
      } catch {
        // Fall through — keep matchName null so we use the user segment.
      }

      // If the parent isn't listable, fall back to the user segment — at
      // worst the downstream call gets a 404 instead of a silent
      // mis-resolution.
      resolved.push(matchName ?? segment);
    }

    return resolved.join("/");
  }

  /** Resolve an already-encoded user path to an encoded FAT short-name path. */
  private async resolveEncodedPath(encodedPath: string, storage: string): Promise<string> {
    if (!encodedPath) return encodedPath;

    // Optimistically try the path as-is — Buddy firmware's FatFS LFN support
    // means a long display-name path like "Forschung/AT10/Tool/file.bgcode"
    // is usually resolved without any per-segment walk. This collapses the
    // entire pre-download chatter into a single probe, which is critical
    // when the printer's HTTP server is slow (digest-auth dance per request).
    try {
      await this.client.get(`/api/v1/files/${storage}/${encodedPath}`);
      return encodedPath;
    } catch {
      // Fall back to segment-by-segment resolution against display_name.
    }

    const shortPath = await this.resolveStoragePath(encodedPath, storage);
    return shortPath.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  }

  async getFile(path: string): Promise<FileDto> {
    const storage = await this.getInternalStorage();
    const resolved = await this.resolveEncodedPath(path, storage);
    const response = await this.getFileRaw(resolved, storage);

    const isDir = (response.data.type ?? "").toUpperCase() === "FOLDER";
    return {
      path: response.data.display_name ?? response.data.name,
      size: response.data.size ?? null,
      date: response.data.m_timestamp ?? null,
      dir: isDir,
      displayName: response.data.display_name ?? null,
    };
  }

  async getStatus(): Promise<PL_StatusDto> {
    const response = await this.client.get<PL_StatusDto>("/api/v1/status");
    return response.data;
  }

  async getPrinterState(): Promise<PL_PrinterStateDto> {
    // OctoPrint compatibility
    const response = await this.client.get<PL_PrinterStateDto>("/api/printer");
    return response.data;
  }

  async getJobState(): Promise<PL_JobStateDto> {
    // OctoPrint compatibility
    const response = await this.client.get<PL_JobStateDto>("/api/job");
    return response.data;
  }

  /**
   * PrusaLink has no "connect" concept — the printer is reachable when the
   * Buddy board is on and the HTTP server is up. Validate by hitting `/api/version`
   * so the caller still gets a real error when the box is unreachable.
   */
  async connect(): Promise<void> {
    await this.validateConnection();
  }

  /** PrusaLink has no "disconnect" — no-op so the dashboard doesn't 500. */
  async disconnect(): Promise<void> {
    // intentionally a no-op
  }

  restartServer(): Promise<void> {
    return this.rejectUnsupported(
      "Restarting the PrusaLink service over HTTP isn't supported — power-cycle the printer instead.",
    );
  }

  restartHost(): Promise<void> {
    return this.rejectUnsupported(
      "PrusaLink doesn't expose a host-reboot endpoint — power-cycle the printer manually.",
    );
  }

  restartPrinterFirmware(): Promise<void> {
    return this.rejectUnsupported(
      "Restarting the printer firmware over PrusaLink isn't supported — reset the printer via the front panel.",
    );
  }

  async startPrint(path: string): Promise<void> {
    // Refuse to enqueue a second print on top of an active one — PrusaLink
    // would reply with a generic 409 and the user gets no useful feedback.
    try {
      const status = await this.getStatus();
      const linkState = (status.printer?.state ?? "").toUpperCase();
      const busyStates = new Set(["PRINTING", "PAUSED", "PAUSING", "BUSY", "ATTENTION"]);
      if (status.job?.id || busyStates.has(linkState)) {
        throw new ExternalServiceError(
          {
            error: "PrusaLink is busy with another job — cancel or wait for it to finish before starting a new print.",
            statusCode: 409,
            success: false,
          },
          "Prusa-Link",
        );
      }
    } catch (e) {
      // If the status probe fails for any non-ExternalServiceError reason we
      // still try to start the print — the printer will reject it cleanly.
      if (e instanceof ExternalServiceError) throw e;
    }

    const storage = await this.getInternalStorage();
    const resolved = await this.resolveEncodedPath(path, storage);
    await this.client.post<void>(`/api/v1/files/${storage}/${resolved}`);
  }

  async pausePrint(): Promise<void> {
    await this.runJobControl("pause", (jobId) => this.client.put<void>(`/api/v1/job/${jobId}/pause`));
  }

  async resumePrint(): Promise<void> {
    await this.runJobControl("resume", (jobId) => this.client.put<void>(`/api/v1/job/${jobId}/resume`));
  }

  async cancelPrint(): Promise<void> {
    await this.runJobControl("cancel", (jobId) => this.client.delete<void>(`/api/v1/job/${jobId}`));
  }

  /**
   * Run a job-control action with a fallback path for printers in ATTENTION /
   * mid-error states. Buddy firmware sometimes drops `status.job.id` from
   * `/api/v1/status` while waiting on the user (filament runout, calibration,
   * etc.), which would make the v1 endpoint un-callable. We retry the legacy
   * OctoPrint-compatible `POST /api/job` body — it doesn't need a job id and
   * is the one PrusaLink-Web itself uses for the "Stop" button.
   */
  private async runJobControl(
    action: "pause" | "resume" | "cancel",
    callV1: (jobId: number) => Promise<unknown>,
  ): Promise<void> {
    const status = await this.getStatus();
    const jobId = status.job?.id;
    // States where a job is genuinely in flight. Buddy can drop status.job.id
    // mid-ATTENTION (filament runout, calibration), so those still count as
    // actionable even without an id.
    const activeStates = new Set(["PRINTING", "PAUSED", "PAUSING", "BUSY", "ATTENTION"]);
    const isActive = activeStates.has((status.printer?.state ?? "").toUpperCase());

    if (jobId) {
      try {
        await callV1(jobId);
        return;
      } catch (err) {
        const httpStatus = (err as AxiosError)?.response?.status;
        // Only fall back when the v1 endpoint actually rejected this specific
        // command — network errors and 401s should still surface.
        if (httpStatus !== 404 && httpStatus !== 409 && httpStatus !== 405) throw err;
        this.logger.warn(
          `PrusaLink v1 ${action} returned ${httpStatus}; trying OctoPrint-compat fallback`,
          this.logMeta(),
        );
      }
    } else if (!isActive) {
      // No job id and the printer is idle/finished — there's nothing to control.
      // Reject clearly instead of firing the legacy command, which some firmware
      // (the MK3's standalone PrusaLink) accepts as a silent no-op even when no
      // print is running.
      throw new ExternalServiceError(
        { error: `No active print to ${action}.`, statusCode: 409, success: false },
        "Prusa-Link",
      );
    }

    // Legacy OctoPrint-compat fallback: reached either after a v1 failure (job
    // known to exist) or when status.job.id is missing but the printer is in an
    // active/ATTENTION state where Buddy hides the id.
    const legacyCommand = action === "cancel" ? "cancel" : action;
    try {
      await this.client.post<void>("/api/job", { command: legacyCommand });
    } catch (err) {
      throw new ExternalServiceError(
        {
          error:
            action === "cancel"
              ? "Could not cancel the print. The printer may be in ATTENTION — resolve it from the front panel, then try again."
              : `Could not ${action} the print. The printer didn't accept the command — try again or use the front panel.`,
          statusCode: (err as AxiosError)?.response?.status ?? 409,
          success: false,
        },
        "Prusa-Link",
      );
    }
  }

  quickStop(): Promise<void> {
    return this.rejectUnsupported("Emergency-stop over PrusaLink isn't supported. Use the printer's reset button.");
  }

  sendGcode(_script: string): Promise<void> {
    return this.rejectUnsupported(
      "Sending arbitrary G-code over PrusaLink isn't supported by the firmware. Send G-code via a slicer-uploaded file instead.",
    );
  }

  movePrintHead(_amounts: { x?: number; y?: number; z?: number; speed?: number }): Promise<void> {
    return this.rejectUnsupported("Jogging the print head over PrusaLink isn't supported by the firmware.");
  }

  homeAxes(_axes: { x?: boolean; y?: boolean; z?: boolean }): Promise<void> {
    return this.rejectUnsupported("Homing axes over PrusaLink isn't supported by the firmware.");
  }

  async downloadFile(path: string): AxiosPromise<NodeJS.ReadableStream> {
    // Try the LFN path directly. Only walk segment-by-segment if the firmware
    // rejects with 404 (which it shouldn't, since Buddy resolves LFN, but the
    // fallback is here as insurance for older firmware).
    const storage = await this.getInternalStorage();
    let fileReference;
    try {
      fileReference = await this.getFileRaw(path, storage);
    } catch (e: any) {
      if (e?.response?.status !== 404) throw e;
      const shortPath = await this.resolveStoragePath(path, storage);
      const encoded = shortPath.split("/").filter(Boolean).map(encodeURIComponent).join("/");
      fileReference = await this.getFileRaw(encoded, storage);
    }
    const pathUrl = fileReference.data.refs.download;
    const displayName = fileReference.data.display_name;

    const response = await this.client.get(pathUrl, {
      responseType: "stream",
    });

    // The FAT filesystem on the printer's USB stick stores files under
    // 8.3 short names (e.g. `1XAT6-~1.BGC`), and PrusaLink's download response
    // sets Content-Disposition with that shortened name. Replace it with the
    // long display name so browsers save the file with its original filename.
    if (displayName) {
      const safe = displayName.replace(/"/g, "");
      response.headers["content-disposition"] =
        `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(displayName)}`;
    }

    return response;
  }

  async getFileChunk(path: string, startBytes: number, endBytes: number): AxiosPromise<string> {
    const storage = await this.getInternalStorage();
    const resolved = await this.resolveEncodedPath(path, storage);
    const fileReference = await this.getFileRaw(resolved, storage);
    const pathUrl = fileReference.data.refs.download;

    return await this.createClient((o) =>
      o.withHeaders({
        Range: `bytes=${startBytes}-${endBytes}`,
      }),
    ).get<string>(pathUrl);
  }

  async uploadFile(input: UploadFileInput): Promise<void> {
    const validated = uploadFileInputSchema.parse(input);

    // Resolve the capability profile up-front: it tells us the printer model
    // (Buddy 32-bit vs Marlin 8-bit Einsy), which gates both `.bgcode` support
    // and the upload transport chosen further down.
    const caps = await this.getCapabilities();

    if (validated.fileName.toLowerCase().endsWith(".bgcode")) {
      if (caps.supportsBgcode === false) {
        const label = caps.model ?? "this PrusaLink printer";
        throw new ExternalServiceError(
          {
            error: `Binary G-code (.bgcode) cannot be printed on ${label}. Re-slice as plain .gcode or use a Buddy-firmware printer (MK4, MK3.9, MK3.5, XL, MINI+, Core One).`,
            statusCode: 400,
            data: { model: caps.model, versionText: caps.versionText },
            success: false,
          },
          "Prusa-Link",
        );
      }
    }

    // Refuse the upload up-front if the internal storage is too small to hold
    // the file. We treat status as best-effort — if the probe fails, let the
    // actual PUT surface the error.
    try {
      const status = await this.getStatus();
      const freeSpace = this.getStorageList(status).find((s) => !s.read_only)?.free_space;
      if (typeof freeSpace === "number" && freeSpace > 0 && freeSpace < validated.contentLength) {
        throw new ExternalServiceError(
          {
            error: `Not enough free space on the printer storage: needs ${validated.contentLength} bytes but only ${freeSpace} are available.`,
            statusCode: 507,
            data: { freeSpace, requiredBytes: validated.contentLength },
            success: false,
          },
          "Prusa-Link",
        );
      }
    } catch (e) {
      if (e instanceof ExternalServiceError) throw e;
    }

    // Resolve the destination subfolder (if any) against display_name first
    // so the PUT lands in the same folder the user is browsing.
    const storage = await this.getInternalStorage();
    const targetSubfolder = (validated.targetPath ?? "").replace(/^\/+|\/+$/g, "");
    const subfolderResolved = targetSubfolder ? await this.resolveStoragePath(targetSubfolder, storage) : "";
    const subfolderEncoded = subfolderResolved.split("/").filter(Boolean).map(encodeURIComponent).join("/");
    const uploadPath = subfolderEncoded
      ? `/api/v1/files/${storage}/${subfolderEncoded}/${encodeURIComponent(validated.fileName)}`
      : `/api/v1/files/${storage}/${encodeURIComponent(validated.fileName)}`;

    // PrusaLink upload directives. Sent per-request (not baked into the client)
    // so the priming GET below isn't poisoned with the file's Content-Length.
    const uploadHeaders = {
      "Content-Type": "application/octet-stream",
      "Content-Length": validated.contentLength.toString(),
      Overwrite: "?1",
      "Print-After-Upload": validated.startPrint ? "?1" : "?0",
    };

    const buildUploadClient = () =>
      this.createClient((b) => {
        b.withTimeout(this.settingsStore.getTimeoutSettings().apiUploadTimeout).withOnUploadProgress((p) => {
          if (validated.uploadToken) {
            this.eventEmitter2.emit(`${uploadProgressEvent(validated.uploadToken)}`, validated.uploadToken, p);
          }
        });
      });

    // The streaming body can't be replayed, so it must not be the request that
    // triggers the digest 401 → challenge dance (that retry would resend an
    // empty body). MK3/MK2.5 bind the nonce to the TCP connection, so we prime
    // the challenge with a no-body GET on the *same* single-socket client; the
    // request interceptor then signs the upload up-front and it goes out
    // already authenticated on the same connection.

    // Modern Buddy firmware (MK4/XL/MINI/Core One): PUT the raw octet-stream.
    const putWithPriming = async (stream: unknown) => {
      const client = buildUploadClient();
      await client.get("/api/version").catch(() => undefined);
      return client.put(uploadPath, stream, { headers: uploadHeaders });
    };

    // Legacy standalone PrusaLink (MK3/MK2.5 Einsy shim, server 0.x) returns
    // 500 on the modern PUT despite advertising `upload-by-put`. Its working
    // path is the OctoPrint-compatible multipart POST /api/files/<location>.
    const postLegacyMultipart = async (stream: unknown) => {
      const form = new FormData();
      if (validated.startPrint) {
        form.append("print", "true");
      }
      if (subfolderResolved) {
        form.append("path", subfolderResolved);
      }
      form.append("file", stream as never, {
        filename: validated.fileName,
        knownLength: validated.contentLength,
      });
      const length = await new Promise<number>((resolve, reject) =>
        form.getLength((err, len) => (err ? reject(new Error("Could not compute multipart length")) : resolve(len))),
      );
      const client = buildUploadClient();
      await client.get("/api/version").catch(() => undefined);
      return client.post(`/api/files/${storage}`, form, {
        headers: { ...form.getHeaders(), "Content-Length": length.toString() },
      });
    };

    // Einsy boards (no .bgcode support) only accept the legacy multipart POST.
    const useLegacyMultipart = caps.uploadTransport === "legacyMultipart";

    try {
      let response;
      if (useLegacyMultipart) {
        response = await postLegacyMultipart(validated.stream);
      } else {
        try {
          response = await putWithPriming(validated.stream);
        } catch (firstErr: any) {
          // Priming should make the PUT authenticate on the first try. If it
          // still fails, retry once from a fresh stream: a 401 means the nonce
          // expired between the GET and the PUT; a 5xx means this firmware
          // advertises upload-by-put but can't honour it, so fall back to the
          // legacy multipart POST.
          const status = (firstErr as AxiosError)?.response?.status;
          if (typeof validated.streamFactory !== "function") {
            throw firstErr;
          }
          if (status === 401) {
            this.logger.debug("Upload hit a 401 after priming; retrying once with a fresh stream", this.logMeta());
            response = await putWithPriming(validated.streamFactory());
          } else if (status && status >= 500) {
            this.logger.warn(`Upload PUT returned ${status}; falling back to legacy multipart POST`, this.logMeta());
            response = await postLegacyMultipart(validated.streamFactory());
          } else {
            throw firstErr;
          }
        }
      }

      if (validated.uploadToken) {
        this.eventEmitter2.emit(`${uploadDoneEvent(validated.uploadToken)}`, validated.uploadToken);
      }

      return response.data;
    } catch (e: any) {
      if (validated.uploadToken) {
        this.eventEmitter2.emit(
          `${uploadFailedEvent(validated.uploadToken)}`,
          validated.uploadToken,
          (e as AxiosError)?.message ?? e?.message,
        );
      }

      // axios surfaces the error body on `response.data`, not `response.body`,
      // and the HTTP status on `response.status`. Keep the resilient parse in
      // case the body is a JSON string (some PrusaLink errors arrive that way).
      const rawData = (e as AxiosError)?.response?.data;
      let data: unknown = rawData;
      if (typeof rawData === "string") {
        try {
          data = JSON.parse(rawData);
        } catch {
          data = rawData;
        }
      }

      // Translate common PrusaLink upload failures into actionable messages.
      const status = (e as AxiosError)?.response?.status;
      let friendly = e?.message ?? "Upload failed";
      if (status === 401) {
        friendly = "PrusaLink rejected the upload: invalid username or password.";
      } else if (status === 409) {
        friendly = "PrusaLink rejected the upload: a file with that name already exists and overwrite was refused.";
      } else if (status === 413) {
        friendly = "PrusaLink rejected the upload: file is larger than the printer storage allows.";
      } else if (status === 415) {
        friendly = "PrusaLink rejected the upload: file format not supported by this firmware.";
      } else if (status === 507) {
        friendly = "PrusaLink rejected the upload: not enough free space on the printer storage.";
      }

      throw new ExternalServiceError(
        {
          error: friendly,
          statusCode: status,
          data,
          success: false,
          stack: e?.stack,
        },
        "Prusa-Link",
      );
    }
  }

  async deleteFile(path: string): Promise<void> {
    const storage = await this.getInternalStorage();
    const resolved = await this.resolveEncodedPath(path, storage);
    try {
      await this.client.delete<void>(`/api/v1/files/${storage}/${resolved}`);
    } catch (e) {
      this.throwDeleteError(e, "file");
    }
  }

  async deleteFolder(path: string): Promise<void> {
    const storage = await this.getInternalStorage();
    const resolved = await this.resolveEncodedPath(path, storage);
    try {
      await this.client.delete<void>(`/api/v1/files/${storage}/${resolved}`);
    } catch (e) {
      this.throwDeleteError(e, "folder");
    }
  }

  /**
   * Translate a delete failure into an actionable error. PrusaLink answers
   * `409 Conflict` when the target is **in use** — not just when it's being
   * printed, but also when the file is "open" on the printer (the Buddy print
   * preview / confirm screen selects the file, and a selected file can't be
   * deleted until it's deselected or the preview is cancelled). That state is
   * NOT visible in `/api/v1/status` or `/api/v1/job`, so the 409 is the only
   * signal — surface it as a clear instruction instead of a raw HTTP error.
   */
  private throwDeleteError(e: unknown, kind: "file" | "folder"): never {
    const status = (e as AxiosError)?.response?.status;
    if (status === 409) {
      throw new ExternalServiceError(
        {
          error:
            kind === "file"
              ? "PrusaLink won't delete this file because it's in use — it's either printing or open in the print preview on the printer. Cancel or deselect it on the printer screen, then try again."
              : "PrusaLink won't delete this folder because a file inside it is in use — it's either printing or open in the print preview. Cancel or deselect it on the printer screen, then try again.",
          statusCode: 409,
          success: false,
        },
        "Prusa-Link",
      );
    }
    throw e;
  }

  /**
   * Create a folder on the internal printing storage. PrusaLink uses a PUT
   * against the target path with the `Create-Folder: ?1` directive (POST 404s
   * — the modern files API only routes folder creation through PUT). The
   * parent segments are resolved through display_name first so the request
   * lands in the same place the user is browsing.
   */
  async createFolder(path: string): Promise<void> {
    const trimmed = (path ?? "").replace(/^\/+|\/+$/g, "");
    if (!trimmed) {
      throw new ExternalServiceError(
        { error: "Folder path is required.", statusCode: 400, success: false },
        "Prusa-Link",
      );
    }

    const storage = await this.getInternalStorage();
    const segments = trimmed.split("/").filter(Boolean);
    const newName = segments.pop()!;
    const parentResolved = await this.resolveStoragePath(segments.join("/"), storage);
    const parentEncoded = parentResolved.split("/").filter(Boolean).map(encodeURIComponent).join("/");
    const targetEncoded = parentEncoded
      ? `${parentEncoded}/${encodeURIComponent(newName)}`
      : encodeURIComponent(newName);

    await this.createClient((b) => {
      b.withHeaders({ "Create-Folder": "?1" });
    }).put<void>(`/api/v1/files/${storage}/${targetEncoded}`);
  }

  getSettings(): Promise<ServerConfigDto | SettingsDto> {
    return this.rejectUnsupported(
      "PrusaLink doesn't expose a settings document; check the printer's front panel instead.",
    );
  }

  /**
   * List cameras attached to the printer. Returns the firmware payload
   * verbatim — the controller passes it through so the frontend can render
   * whatever fields each PrusaLink version exposes.
   */
  async listCameras(): Promise<unknown[]> {
    try {
      const response = await this.client.get<{ camera_list?: unknown[] } | unknown[]>("/api/v1/cameras");
      const data = response.data as { camera_list?: unknown[] };
      if (Array.isArray(data)) return data;
      return data?.camera_list ?? [];
    } catch (e) {
      // Firmware without the cameras endpoint (e.g. some Buddy builds like the
      // XL's 2.1.2, or the legacy Einsy shim) answers 404. Treat that as "no
      // cameras" so the camera UI degrades gracefully instead of surfacing an
      // error — mirrors how the MK3 returns an empty list. Re-throw everything
      // else (auth, network, 5xx).
      if ((e as AxiosError)?.response?.status === 404) return [];
      throw e;
    }
  }

  /**
   * Stream a snapshot JPEG from a camera. When `cameraId` is omitted we hit
   * `/api/v1/cameras/snap`, which Buddy maps to the default/first camera —
   * convenient for printers with a single board-attached camera.
   */
  async getCameraSnapshot(cameraId?: string): AxiosPromise<NodeJS.ReadableStream> {
    const path = cameraId ? `/api/v1/cameras/${encodeURIComponent(cameraId)}/snap` : `/api/v1/cameras/snap`;
    return this.client.get(path, { responseType: "stream" });
  }

  /**
   * Stream the firmware-stored thumbnail for a file. We hit `/api/v1/files/<storage>/<path>`
   * first to read the `refs.icon` (small) / `refs.thumbnail` (big) URL the
   * printer advertises, then stream that URL back. Some firmwares publish only
   * the big one (the small `icon` path can 404), so we fall back across both
   * to keep the call useful on every firmware.
   */
  async getFileThumbnail(path: string, variant: "small" | "big" = "big"): AxiosPromise<NodeJS.ReadableStream> {
    const storage = await this.getInternalStorage();
    const resolved = await this.resolveEncodedPath(path, storage);
    const file = await this.getFileRaw(resolved, storage);
    const refs = file.data?.refs as { icon?: string | null; thumbnail?: string | null } | undefined;
    const url = (variant === "big" ? refs?.thumbnail : refs?.icon) ?? refs?.thumbnail ?? refs?.icon;
    if (!url) {
      throw new ExternalServiceError(
        {
          error:
            "PrusaLink doesn't have a thumbnail for this file — re-slice with thumbnails enabled or upload a .bgcode file.",
          statusCode: 404,
          success: false,
        },
        "Prusa-Link",
      );
    }
    return this.client.get(url, { responseType: "stream" });
  }

  /**
   * PrusaLink doesn't expose a "last print" snapshot — when no job is in
   * flight, the `/api/v1/status.job` field disappears. Surface a benign
   * "no last print" state instead of throwing so reprint UIs degrade gracefully.
   */
  async getReprintState(): Promise<PartialReprintFileDto> {
    try {
      const status = await this.getStatus();
      const jobFile = (status as any).job?.file;
      if (!jobFile?.path) {
        return { reprintState: ReprintState.NoLastPrint, connectionState: null };
      }
      return {
        reprintState: ReprintState.LastPrintReady,
        connectionState: null,
        file: {
          path: jobFile.display_name ?? jobFile.path,
          size: jobFile.size ?? null,
          date: jobFile.m_timestamp ?? null,
          dir: false,
          displayName: jobFile.display_name ?? null,
        },
      };
    } catch {
      return { reprintState: ReprintState.PrinterNotAvailable, connectionState: null };
    }
  }

  private getFileRaw(path: string, storage: string) {
    return this.client.get<PL_FileDto>(`/api/v1/files/${storage}/${path}`);
  }

  /**
   * The printer's "internal printing storage" — the writable storage where
   * gcodes are uploaded to and printed from. This is the generic notion the
   * rest of the stack calls "usb": on Buddy firmware (MK4/XL/MINI/Core One)
   * it really is `usb`, but on the Einsy shim (MK3/MK2.5) the equivalent is
   * `local` (the box exposes /local + a read-only /sdcard and no /usb).
   *
   * Resolved from `/api/v1/status` (first writable storage, else the first
   * reported one) and memoized, since a printer's storage layout is fixed.
   * Falls back to `usb` when status can't be read.
   */
  private async getInternalStorage(): Promise<string> {
    if (this.internalStorageSegment) {
      return this.internalStorageSegment;
    }
    try {
      const list = this.getStorageList(await this.getStatus());
      const chosen = (list.find((s) => s?.path && !s.read_only) ?? list[0])?.path;
      if (chosen) {
        this.internalStorageSegment = chosen.replace(/^\/+|\/+$/g, "").toLowerCase();
        return this.internalStorageSegment;
      }
    } catch {
      // Status probe failed — fall back to the legacy default below.
    }
    return "usb";
  }

  /** Normalize `status.storage` (single object on Buddy, array on Einsy) to an array. */
  private getStorageList(status: PL_StatusDto): PL_StorageDto[] {
    const s = status.storage;
    if (Array.isArray(s)) return s;
    return s ? [s] : [];
  }

  /**
   * Shared helper for endpoints the firmware simply doesn't expose. Returns a
   * rejected promise (instead of throwing synchronously) so callers can use
   * `await` and try/catch uniformly.
   */
  private rejectUnsupported(message: string): Promise<never> {
    return Promise.reject(new ExternalServiceError({ error: message, statusCode: 501, success: false }, "Prusa-Link"));
  }

  private createClient(buildFluentOptions?: (base: PrusaLinkHttpClientBuilder) => void) {
    const builder = new PrusaLinkHttpClientBuilder();

    return this.httpClientFactory.createClientWithBaseUrl(builder, this.printerLogin.printerURL, (b) => {
      this.logger.debug("Building API client", this.logMeta());

      // Buddy firmware accepts two auth schemes:
      //   - HTTP Digest with the username/password printed on the front-panel
      //   - `X-Api-Key` with the "Printer API key" from front-panel → Network
      // Prefer digest when both are present (it's the more privileged scheme
      // and what existing setups already use); fall through to the API key
      // when no password is configured.
      const hasDigestCreds = !!this.printerLogin.username?.length && !!this.printerLogin.password?.length;
      const hasApiKey = !!this.printerLogin.apiKey?.length;

      if (hasDigestCreds) {
        b.withDigestAuth(
          this.printerLogin.username,
          this.printerLogin.password,
          (error) => {
            this.logger.error(`Authentication error occurred for ${this.printerLogin?.printerURL}: ${error?.message}`);
          },
          (error, attemptCount) => {
            this.logger.log(
              `Authentication attempt count ${attemptCount} for method ${error.config?.method?.toUpperCase()} path ${error.config?.url}`,
              this.logMeta(),
            );
          },
          (authHeader) => {
            this.logger.debug("Authentication successful", this.logMeta());
            this.authHeader = authHeader;
          },
        );

        // NOTE: we intentionally do NOT pre-seed the builder with a cached
        // Authorization header. Each `createClient()` builds a fresh builder
        // with its own per-nonce request counter (`nc`) starting at 1.
        // Reusing a cached header across builders means several requests send
        // `nc=00000001` against the same nonce — which the standalone
        // PrusaLink on a Raspberry Pi (MK3/MK2.5) strictly validates and 401s
        // as a replay. Letting every request run its own 401 → challenge →
        // retry handshake gives each one a fresh server nonce, so `nc=1` is
        // always valid. The extra round-trip is negligible at a 5s poll.
      } else if (hasApiKey) {
        b.withHeaders({ [apiKeyHeaderKey]: this.printerLogin.apiKey! });
      } else {
        this.logger.warn(
          "No credentials configured for PrusaLink printer — requests will be unauthenticated",
          this.logMeta(),
        );
      }

      if (buildFluentOptions && typeof buildFluentOptions === "function") {
        buildFluentOptions(b);
      }
    });
  }

  private logMeta() {
    return { ...defaultLog, printerURL: this.printerLogin?.printerURL };
  }
}
