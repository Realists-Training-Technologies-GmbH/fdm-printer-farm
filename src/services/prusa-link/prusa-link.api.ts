import { HttpClientFactory } from "@/services/core/http-client.factory";
import { LoggerService } from "@/handlers/logger";
import type { ILoggerFactory } from "@/handlers/logger-factory";
import {
  FileDto,
  IPrinterApi,
  PartialReprintFileDto,
  PrinterType,
  PrusaLinkType,
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
      throw new Error("Recursive listing not supported for PrusaLink printers");
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

    const encodeSegments = (p: string) =>
      p.split("/").filter(Boolean).map(encodeURIComponent).join("/");
    // `/api/v1/files/{storage}` paginates and returns a small default page
    // (10 items on current Buddy firmware), which silently hides folders past
    // the first page. Ask for a large window — the firmware caps at its
    // internal max, so over-asking is safe.
    const listingQuery = "?offset=0&limit=1000";
    const buildUrl = (encoded: string) =>
      encoded
        ? `/api/v1/files/${storage}/${encoded}${listingQuery}`
        : `/api/v1/files/${storage}${listingQuery}`;

    const directEncoded = encodeSegments(relPath);
    let response;
    let resolvedEncodedParent = directEncoded;
    try {
      response = await this.client.get<ListingResponse>(buildUrl(directEncoded));
    } catch {
      const shortRel = await this.resolveStoragePath(relPath, storage);
      resolvedEncodedParent = encodeSegments(shortRel);
      response = await this.client.get<ListingResponse>(buildUrl(resolvedEncodedParent));
    }

    const children = response.data?.children ?? [];
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
    const missingSize = baseItems
      .filter((i) => !i.dir && i.size === null)
      .slice(0, sizeFetchCap);
    if (missingSize.length > 0) {
      const sizes = await Promise.all(
        children
          .filter((c) => (c.type ?? "").toUpperCase() !== "FOLDER" && c.size == null)
          .slice(0, sizeFetchCap)
          .map((c) => {
            const encodedChild = resolvedEncodedParent
              ? `${resolvedEncodedParent}/${encodeURIComponent(c.name)}`
              : encodeURIComponent(c.name);
            return this.getFileRaw(encodedChild)
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

    const resolved: string[] = [];
    for (const segment of segments) {
      const parentEncoded = resolved.map(encodeURIComponent).join("/");
      const url = parentEncoded
        ? `/api/v1/files/${storage}/${parentEncoded}?offset=0&limit=1000`
        : `/api/v1/files/${storage}?offset=0&limit=1000`;

      try {
        const response = await this.client.get<{
          children?: Array<{ name: string; display_name?: string }>;
        }>(url);
        const match = response.data?.children?.find(
          (c) => c.display_name === segment || c.name === segment,
        );
        resolved.push(match?.name ?? segment);
      } catch {
        // If the parent isn't listable for any reason, fall back to the user
        // segment — at worst the downstream call gets a 404 instead of a
        // silent mis-resolution.
        resolved.push(segment);
      }
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

    return {
      path: response.data.display_name ?? response.data.name,
      size: response.data.size,
      date: response.data.m_timestamp ?? null,
      dir: false,
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

  connect(): Promise<void> {
    throw new Error("Method not implemented.");
  }

  disconnect(): Promise<void> {
    throw new Error("Method not implemented.");
  }

  restartServer(): Promise<void> {
    throw new Error("Method not implemented.");
  }

  restartHost(): Promise<void> {
    throw new Error("Method not implemented.");
  }

  restartPrinterFirmware(): Promise<void> {
    throw new Error("Method not implemented.");
  }

  async startPrint(path: string): Promise<void> {
    const resolved = await this.resolveEncodedPath(path);
    await this.client.post<void>(`/api/v1/files/usb/${resolved}`);
  }

  async pausePrint(): Promise<void> {
    const jobId = await this.getCurrentJobId();
    if (!jobId) {
      this.logger.warn("Job pause command did not complete, job or job id not set");
      return;
    }
    await this.client.put<void>(`/api/v1/job/${jobId}/pause`);
  }

  async resumePrint(): Promise<void> {
    const jobId = await this.getCurrentJobId();
    if (!jobId) {
      this.logger.warn("Job resume command did not complete, job or job id not set");
      return;
    }
    await this.client.put<void>(`/api/v1/job/${jobId}/resume`);
  }

  async cancelPrint(): Promise<void> {
    const jobId = await this.getCurrentJobId();
    if (!jobId) {
      this.logger.warn("Job cancel command did not complete, job or job id not set");
      return;
    }
    await this.client.delete<void>(`/api/v1/job/${jobId}`);
  }

  quickStop(): Promise<void> {
    throw new Error("Method not implemented.");
  }

  sendGcode(script: string): Promise<void> {
    throw new Error("Method not implemented.");
  }

  movePrintHead(amounts: { x?: number; y?: number; z?: number; speed?: number }): Promise<void> {
    throw new Error("Method not implemented.");
  }

  homeAxes(axes: { x?: boolean; y?: boolean; z?: boolean }): Promise<void> {
    throw new Error("Method not implemented.");
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
      response.headers["content-disposition"] = `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(displayName)}`;
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

    try {
      const response = await this.createClient((b) => {
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
      }).put(`/api/v1/files/usb/${encodeURIComponent(validated.fileName)}`, validated.stream);

      if (validated.uploadToken) {
        this.eventEmitter2.emit(`${uploadDoneEvent(validated.uploadToken)}`, validated.uploadToken);
      }

      return response.data;
    } catch (e: any) {
      if (validated.uploadToken) {
        this.eventEmitter2.emit(
          `${uploadFailedEvent(validated.uploadToken)}`,
          validated.uploadToken,
          (e as AxiosError)?.message,
        );
      }

      let data;
      try {
        data = JSON.parse(e.response?.body);
      } catch {
        data = e.response?.body;
      }

      throw new ExternalServiceError(
        {
          error: e.message,
          statusCode: e.response?.statusCode,
          data,
          success: false,
          stack: e.stack,
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

  getSettings(): Promise<ServerConfigDto | SettingsDto> {
    throw new Error("Method not implemented.");
  }

  getReprintState(): Promise<PartialReprintFileDto> {
    throw new Error("Method not implemented.");
  }

  private getFileRaw(path: string) {
    return this.client.get<PL_FileDto>(`/api/v1/files/usb/${path}`);
  }

  private async getCurrentJobId() {
    const status = await this.getStatus();
    return status.job?.id;
  }

  private createClient(buildFluentOptions?: (base: PrusaLinkHttpClientBuilder) => void) {
    const builder = new PrusaLinkHttpClientBuilder();

    return this.httpClientFactory.createClientWithBaseUrl(builder, this.printerLogin.printerURL, (b) => {
      this.logger.debug("Building API client", this.logMeta());

      // Set up digest auth with the credentials and an error handler
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

      if (buildFluentOptions && typeof buildFluentOptions === "function") {
        buildFluentOptions(b);
      }
    });
  }

  private logMeta() {
    return defaultLog;
  }
}
