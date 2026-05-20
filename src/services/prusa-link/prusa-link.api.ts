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
import type { LoginDto } from "../interfaces/login.dto";
import type { ServerConfigDto } from "../moonraker/dto/server/server-config.dto";
import type { SettingsDto } from "../octoprint/dto/settings/settings.dto";
import { PrusaLinkHttpClientBuilder } from "@/services/prusa-link/utils/prusa-link-http-client.builder";
import type { VersionDto } from "@/services/prusa-link/dto/version.dto";
import type { PL_StatusDto } from "@/services/prusa-link/dto/status.dto";
import type { PL_PrinterStateDto } from "@/services/prusa-link/dto/printer-state.dto";
import type { PL_JobStateDto } from "@/services/prusa-link/dto/job-state.dto";
import { uploadDoneEvent, uploadFailedEvent, uploadProgressEvent } from "@/constants/event.constants";
import { ExternalServiceError } from "@/exceptions/runtime.exceptions";
import EventEmitter2 from "eventemitter2";
import type { PL_FileDto } from "@/services/prusa-link/dto/file.dto";
import { SettingsStore } from "@/state/settings.store";
import { parsePrusaLinkModel } from "@/services/prusa-link/utils/prusa-link-model.util";
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

  async validateConnection(): Promise<void> {
    await this.getVersion();
  }

  async getFiles(recursive = false, startDir = "/usb") {
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
    const storageMatch = trimmed.match(/^(usb|local)(?:\/(.+))?$/i);
    const storage = (storageMatch?.[1] ?? "usb").toLowerCase();
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
    // the individual `/api/v1/files/usb/<path>` endpoint does). Fetch sizes
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
  private async resolveStoragePath(userPath: string, storage = "usb"): Promise<string> {
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
  private async resolveEncodedPath(encodedPath: string, storage = "usb"): Promise<string> {
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
    const resolved = await this.resolveEncodedPath(path);
    const response = await this.getFileRaw(resolved);

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

    const resolved = await this.resolveEncodedPath(path);
    await this.client.post<void>(`/api/v1/files/usb/${resolved}`);
  }

  async pausePrint(): Promise<void> {
    const jobId = await this.requireCurrentJobId("pause");
    await this.client.put<void>(`/api/v1/job/${jobId}/pause`);
  }

  async resumePrint(): Promise<void> {
    const jobId = await this.requireCurrentJobId("resume");
    await this.client.put<void>(`/api/v1/job/${jobId}/resume`);
  }

  async cancelPrint(): Promise<void> {
    const jobId = await this.requireCurrentJobId("cancel");
    await this.client.delete<void>(`/api/v1/job/${jobId}`);
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
    let fileReference;
    try {
      fileReference = await this.getFileRaw(path);
    } catch (e: any) {
      if (e?.response?.status !== 404) throw e;
      const shortPath = await this.resolveStoragePath(path);
      const encoded = shortPath.split("/").filter(Boolean).map(encodeURIComponent).join("/");
      fileReference = await this.getFileRaw(encoded);
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
    const resolved = await this.resolveEncodedPath(path);
    const fileReference = await this.getFileRaw(resolved);
    const pathUrl = fileReference.data.refs.download;

    return await this.createClient((o) =>
      o.withHeaders({
        Range: `bytes=${startBytes}-${endBytes}`,
      }),
    ).get<string>(pathUrl);
  }

  async uploadFile(input: UploadFileInput): Promise<void> {
    const validated = uploadFileInputSchema.parse(input);

    // Prime the digest-auth nonce with a no-body request so the upload PUT below
    // doesn't trigger a 401 retry that would silently send an empty stream body.
    // We use the full /api/version payload so we can also gate `.bgcode`
    // uploads on the actual printer model (Buddy 32-bit vs Marlin 8-bit).
    const versionInfo = await this.getVersionInfo();

    if (validated.fileName.toLowerCase().endsWith(".bgcode")) {
      const modelInfo = parsePrusaLinkModel(versionInfo);
      if (modelInfo.supportsBgcode === false) {
        const label = modelInfo.model ?? "this PrusaLink printer";
        throw new ExternalServiceError(
          {
            error: `Binary G-code (.bgcode) cannot be printed on ${label}. Re-slice as plain .gcode or use a Buddy-firmware printer (MK4, MK3.9, MK3.5, XL, MINI+, Core One).`,
            statusCode: 400,
            data: { model: modelInfo.model, versionText: versionInfo.text },
            success: false,
          },
          "Prusa-Link",
        );
      }
    }

    // Refuse the upload up-front if the USB is too small to hold the file.
    // We treat status as best-effort — if the probe fails, let the actual PUT
    // surface the error.
    try {
      const status = await this.getStatus();
      const freeSpace = status.storage?.free_space;
      if (typeof freeSpace === "number" && freeSpace > 0 && freeSpace < validated.contentLength) {
        throw new ExternalServiceError(
          {
            error: `Not enough free space on the USB drive: needs ${validated.contentLength} bytes but only ${freeSpace} are available.`,
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
    const targetSubfolder = (validated.targetPath ?? "").replace(/^\/+|\/+$/g, "");
    const subfolderResolved = targetSubfolder ? await this.resolveStoragePath(targetSubfolder) : "";
    const subfolderEncoded = subfolderResolved.split("/").filter(Boolean).map(encodeURIComponent).join("/");
    const uploadPath = subfolderEncoded
      ? `/api/v1/files/usb/${subfolderEncoded}/${encodeURIComponent(validated.fileName)}`
      : `/api/v1/files/usb/${encodeURIComponent(validated.fileName)}`;

    const buildUploadClient = () =>
      this.createClient((b) => {
        b.withHeaders({
          "Content-Type": "application/octet-stream",
          "Content-Length": validated.contentLength.toString(),
          Overwrite: "?1",
          "Print-After-Upload": validated.startPrint ? "?1" : "?0",
        })
          .withTimeout(this.settingsStore.getTimeoutSettings().apiUploadTimeout)
          .withOnUploadProgress((p) => {
            if (validated.uploadToken) {
              this.eventEmitter2.emit(`${uploadProgressEvent(validated.uploadToken)}`, validated.uploadToken, p);
            }
          });
      });

    try {
      let response;
      try {
        response = await buildUploadClient().put(uploadPath, validated.stream);
      } catch (firstErr: any) {
        // PrusaLink's digest interceptor refuses to replay a Readable body, so
        // a first 401 leaves the connection un-authenticated. With a fresh
        // stream we can retry exactly once — the auth header is now cached
        // and the PUT goes through cleanly.
        const status = (firstErr as AxiosError)?.response?.status;
        if (status === 401 && typeof validated.streamFactory === "function") {
          this.logger.debug("Upload hit a 401; retrying once with a fresh stream", this.logMeta());
          response = await buildUploadClient().put(uploadPath, validated.streamFactory());
        } else {
          throw firstErr;
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
        friendly = "PrusaLink rejected the upload: not enough free space on USB.";
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
    const resolved = await this.resolveEncodedPath(path);
    await this.client.delete<void>(`/api/v1/files/usb/${resolved}`);
  }

  async deleteFolder(path: string): Promise<void> {
    const resolved = await this.resolveEncodedPath(path);
    await this.client.delete<void>(`/api/v1/files/usb/${resolved}`);
  }

  /**
   * Create a folder on the USB storage. PrusaLink uses POST against the
   * target path with the `Create-Folder: ?1` directive. The parent segments
   * are resolved through display_name first so the request lands in the same
   * place the user is browsing.
   */
  async createFolder(path: string): Promise<void> {
    const trimmed = (path ?? "").replace(/^\/+|\/+$/g, "");
    if (!trimmed) {
      throw new ExternalServiceError(
        { error: "Folder path is required.", statusCode: 400, success: false },
        "Prusa-Link",
      );
    }

    const segments = trimmed.split("/").filter(Boolean);
    const newName = segments.pop()!;
    const parentResolved = await this.resolveStoragePath(segments.join("/"));
    const parentEncoded = parentResolved.split("/").filter(Boolean).map(encodeURIComponent).join("/");
    const targetEncoded = parentEncoded
      ? `${parentEncoded}/${encodeURIComponent(newName)}`
      : encodeURIComponent(newName);

    await this.createClient((b) => {
      b.withHeaders({ "Create-Folder": "?1" });
    }).post<void>(`/api/v1/files/usb/${targetEncoded}`);
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
    const response = await this.client.get<{ camera_list?: unknown[] } | unknown[]>("/api/v1/cameras");
    const data = response.data as { camera_list?: unknown[] };
    if (Array.isArray(data)) return data;
    return data?.camera_list ?? [];
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
   * Stream the firmware-stored thumbnail for a file. We hit `/api/v1/files/usb/<path>`
   * first to read the `refs.thumbnailSmall|thumbnailBig` URL the printer
   * advertises, then stream that URL back. Falling back to the small variant
   * when the big one isn't published keeps the call useful on every firmware.
   */
  async getFileThumbnail(path: string, variant: "small" | "big" = "big"): AxiosPromise<NodeJS.ReadableStream> {
    const resolved = await this.resolveEncodedPath(path);
    const file = await this.getFileRaw(resolved);
    const refs = file.data?.refs as { thumbnailSmall?: string; thumbnailBig?: string } | undefined;
    const url =
      (variant === "big" ? refs?.thumbnailBig : refs?.thumbnailSmall) ?? refs?.thumbnailSmall ?? refs?.thumbnailBig;
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

  private getFileRaw(path: string, storage = "usb") {
    return this.client.get<PL_FileDto>(`/api/v1/files/${storage}/${path}`);
  }

  private async getCurrentJobId() {
    const status = await this.getStatus();
    return status.job?.id;
  }

  private async requireCurrentJobId(action: string): Promise<number> {
    const jobId = await this.getCurrentJobId();
    if (!jobId) {
      this.logger.warn(`Cannot ${action} print: no active job on this printer`, this.logMeta());
      throw new ExternalServiceError(
        {
          error: `Cannot ${action} print: no active job on this printer.`,
          statusCode: 409,
          success: false,
        },
        "Prusa-Link",
      );
    }
    return jobId;
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
            this.logger.error("Authentication error occurred", error);
          },
          (error, attemptCount) => {
            this.logger.log(
              `Authentication attempt count ${attemptCount} for method ${error.config?.method?.toUpperCase()} path ${error.config?.url}`,
              this.logMeta(),
            );
          },
          (authHeader) => {
            this.logger.debug("Authentication successful, saving auth header for later reuse", this.logMeta());
            this.authHeader = authHeader;
          },
        );

        if (this.authHeader) {
          b.withAuthHeader(this.authHeader);
        }
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
    return defaultLog;
  }
}
