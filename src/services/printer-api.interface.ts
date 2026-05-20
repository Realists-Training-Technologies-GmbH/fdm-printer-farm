import { AxiosPromise } from "axios";
import type { LoginDto } from "@/services/interfaces/login.dto";
import type { ServerConfigDto } from "@/services/moonraker/dto/server/server-config.dto";
import type { SettingsDto } from "@/services/octoprint/dto/settings/settings.dto";
import { ConnectionState } from "@/services/octoprint/dto/connection/connection-state.type";
import { Flags } from "@/services/moonraker/dto/octoprint-compat/api-printer.dto";
import { z } from "zod";
import { Readable } from "node:stream";

export const uploadFileInputSchema = z.object({
  stream: z.custom<Readable>((val) => {
    return val && typeof val === "object" && "pipe" in val && typeof val.pipe === "function";
  }, "Must be a readable stream"),
  fileName: z.string().min(1),
  contentLength: z.number().int().positive(),
  startPrint: z.boolean(),
  uploadToken: z.string().optional(),
  // Optional subfolder (display-name path) to upload into. PrusaLink honors
  // this; other firmwares ignore it for now.
  targetPath: z.string().optional(),
  // Optional factory that produces a fresh readable stream of the same body.
  // PrusaLink uses this to retry after a 401 priming pass — the original
  // stream was already consumed (or rejected mid-flight) and can't be replayed.
  // Implementations that don't need retries can omit it safely.
  streamFactory: z
    .custom<() => Readable>((val) => typeof val === "function", "Must be a function returning a stream")
    .optional(),
});

export type UploadFileInput = z.infer<typeof uploadFileInputSchema>;

export const OctoprintType = 0;
export const MoonrakerType = 1;
export const PrusaLinkType = 2;
export const BambuType = 3;

export enum PrinterTypesEnum {
  Octoprint = 0,
  Moonraker = 1,
  PrusaLink = 2,
  Bambu = 3,
}

export type PrinterType = typeof OctoprintType | typeof MoonrakerType | typeof PrusaLinkType | typeof BambuType;

export interface FdmCurrentMessageDto {
  progress: {
    printTime: number | null;
    completion: number | null;
  };
  state: {
    text: string;
    error: string;
    flags: Flags;
  };
  job: {
    file: {
      name: string;
      path: string;
    };
  };
}

export interface StatusFlags {
  connected: boolean;
  operational: boolean;
  printing: boolean;
  paused: boolean;
  error: boolean;
  finished: boolean;
}

export interface FileDto {
  path: string;
  size: number | null;
  date: number | null;
  dir: boolean;
  // Optional human-readable name when the addressable path is a constrained
  // shortname (e.g. PrusaLink/FAT 8.3 truncations like `1XAT6-~1.BGC`).
  displayName?: string | null;
}

export interface FilesDto {
  dirs: FileDto[];
  files: FileDto[];
}

export enum ReprintState {
  PrinterNotAvailable = 0,
  NoLastPrint = 1,
  LastPrintReady = 2,
}

export interface PartialReprintFileDto {
  file?: FileDto;
  reprintState: ReprintState;
  connectionState: ConnectionState | null;
}

export interface ReprintFileDto extends PartialReprintFileDto {
  printerId: number;
}

export interface IPrinterApi {
  get type(): PrinterType;

  set login(login: LoginDto);

  getVersion(): Promise<string>;

  validateConnection(): Promise<void>;

  connect(): Promise<void>;

  disconnect(): Promise<void>;

  restartServer(): Promise<void>;

  restartHost(): Promise<void>;

  restartPrinterFirmware(): Promise<void>;

  startPrint(path: string): Promise<void>;

  pausePrint(): Promise<void>;

  resumePrint(): Promise<void>;

  cancelPrint(): Promise<void>;

  quickStop(): Promise<void>;

  sendGcode(script: string): Promise<void>;

  movePrintHead(amounts: { x?: number; y?: number; z?: number; speed?: number }): Promise<void>;

  homeAxes(axes: { x?: boolean; y?: boolean; z?: boolean }): Promise<void>;

  getFile(path: string): Promise<FileDto>;

  getFiles(recursive?: boolean, startDir?: string): Promise<FilesDto>;

  downloadFile(path: string): AxiosPromise<NodeJS.ReadableStream>;

  getFileChunk(path: string, startBytes: number, endBytes: number): AxiosPromise<string>;

  uploadFile(input: UploadFileInput): Promise<void>;

  deleteFile(path: string): Promise<void>;

  deleteFolder(path: string): Promise<void>;

  /**
   * Create a folder at `path`. Implementations may throw
   * `NotImplementedException` when the underlying firmware doesn't expose
   * folder creation (e.g. plain OctoPrint).
   */
  createFolder?(path: string): Promise<void>;

  /**
   * List the cameras exposed by the printer (PrusaLink-only today). Returns
   * an opaque array — the controller passes it through verbatim so the
   * frontend can show whatever fields the firmware provides.
   */
  listCameras?(): Promise<unknown[]>;

  /**
   * Stream a snapshot JPEG from a camera attached to the printer. `cameraId`
   * is the firmware-issued id from `listCameras`; when omitted the default
   * camera is used (older firmware exposes only one).
   */
  getCameraSnapshot?(cameraId?: string): AxiosPromise<NodeJS.ReadableStream>;

  /**
   * Stream the firmware-stored thumbnail for a file on the printer. PrusaLink
   * exposes small (~16-24px) and big (~220px) variants embedded in .bgcode /
   * sliced .gcode files. Useful as a fallback when the server hasn't
   * analyzed the file locally.
   */
  getFileThumbnail?(path: string, variant?: "small" | "big"): AxiosPromise<NodeJS.ReadableStream>;

  getSettings(): Promise<ServerConfigDto | SettingsDto>;

  getReprintState(): Promise<PartialReprintFileDto>;
}
