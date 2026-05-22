import { before, DELETE, GET, POST, PUT, route } from "awilix-express";
import { AppConstants } from "@/server.constants";
import type { Request, Response } from "express";
import { authorizeRoles, authenticate } from "@/middleware/authenticate";
import { ROLES } from "@/constants/authorization.constants";
import { PrintQueueService } from "@/services/print-queue.service";
import { PrintJobService } from "@/services/orm/print-job.service";
import { FileStorageService } from "@/services/file-storage.service";
import { FileStorageFolderService } from "@/services/file-storage-folder.service";
import { PrinterCache } from "@/state/printer.cache";
import type { ILoggerFactory } from "@/handlers/logger-factory";
import { LoggerService } from "@/handlers/logger";
import { ParamId } from "@/middleware/param-converter.middleware";
import { BadRequestException, NotFoundException } from "@/exceptions/runtime.exceptions";
import type { FileFormatType, PrintJobMetadata } from "@/entities/print-job.entity";
import { PrusaLinkType, type PrinterType } from "@/services/printer-api.interface";
import { getIncompatibilityReason } from "@/utils/printer-compatibility.util";
import { PrinterFirmwareCache } from "@/state/printer-firmware.cache";
import { arePrusaModelsCompatible, getPrusaPrinterFamily } from "@/services/prusa-link/utils/prusa-link-model.util";
import { PrinterMaintenanceLogService } from "@/services/orm/printer-maintenance-log.service";

@route(AppConstants.apiRoute + "/print-queue")
@before([authenticate(), authorizeRoles([ROLES.ADMIN, ROLES.OPERATOR])])
export class PrintQueueController {
  private readonly logger: LoggerService;

  constructor(
    loggerFactory: ILoggerFactory,
    private readonly printQueueService: PrintQueueService,
    private readonly printJobService: PrintJobService,
    private readonly fileStorageService: FileStorageService,
    private readonly fileStorageFolderService: FileStorageFolderService,
    private readonly printerCache: PrinterCache,
    private readonly printerFirmwareCache: PrinterFirmwareCache,
    private readonly printerMaintenanceLogService: PrinterMaintenanceLogService,
  ) {
    this.logger = loggerFactory(PrintQueueController.name);
  }

  @GET()
  async getGlobalQueue(req: Request, res: Response) {
    try {
      const page = Number.parseInt(req.query.page as string) || 1;
      const pageSize = Number.parseInt(req.query.pageSize as string) || 50;

      if (page < 1 || pageSize < 1 || pageSize > 200) {
        res.status(400).send({ error: "Invalid page or pageSize parameters" });
        return;
      }

      const [jobs, totalCount] = await this.printQueueService.getGlobalQueuePaged(page, pageSize);

      const queueItems = jobs.map((job) => ({
        jobId: job.id,
        fileName: job.fileName,
        printerId: job.printerId,
        printerName: job.printerName || job.printer?.name,
        queuePosition: job.queuePosition,
        status: job.status,
        createdAt: job.createdAt,
        estimatedTimeSeconds: (job.metadata as any)?.gcodePrintTimeSeconds,
        filamentGrams: (job.metadata as any)?.filamentUsedGrams,
      }));

      res.send({
        items: queueItems,
        page,
        pageSize,
        totalCount,
        totalPages: Math.ceil(totalCount / pageSize),
      });
    } catch (error) {
      this.logger.error(`Failed to get global queue: ${error}`);
      res.status(500).send({ error: "Failed to get global queue" });
    }
  }

  /**
   * Return the list of printers that can natively print the given file.
   *
   * Used by the UI to filter the printer picker so users only see printers
   * compatible with the selected file's format. Declared before the
   * `:printerId` parametric route so "compatible-printers" isn't matched as
   * a printer id.
   *
   * Query params (one is required):
   *   - fileStorageId: a file in local file storage
   *   - jobId: an existing print job (uses its fileFormat)
   *   - fileFormat: explicit file format ("gcode" | "bgcode" | "3mf")
   */
  @GET()
  @route("/compatible-printers")
  async getCompatiblePrinters(req: Request, res: Response) {
    const fileStorageId = typeof req.query.fileStorageId === "string" ? req.query.fileStorageId : undefined;
    const fileFormatQuery = typeof req.query.fileFormat === "string" ? req.query.fileFormat : undefined;
    const jobIdQuery = typeof req.query.jobId === "string" ? req.query.jobId : undefined;

    let fileFormat: FileFormatType | undefined;
    let resolvedFileName: string | undefined;
    let slicerTargetModel: string | null = null;

    try {
      if (fileStorageId) {
        const exists = await this.fileStorageService.fileExists(fileStorageId);
        if (!exists) {
          throw new NotFoundException("File not found in storage");
        }
        const metadata = await this.fileStorageService.loadMetadata(fileStorageId);
        fileFormat = (metadata?.fileFormat as FileFormatType | undefined) ?? undefined;
        resolvedFileName = metadata?._originalFileName ?? metadata?.fileName;
        slicerTargetModel = (metadata?.printerModel as string | null) ?? null;
      } else if (jobIdQuery) {
        const jobId = Number.parseInt(jobIdQuery, 10);
        if (Number.isNaN(jobId)) {
          throw new BadRequestException("jobId must be a number");
        }
        const job = await this.printJobService.getJobByIdOrFail(jobId);
        fileFormat = (job.fileFormat as FileFormatType | null) ?? undefined;
        resolvedFileName = job.fileName;
        slicerTargetModel = job.printerModel ?? (job.metadata as any)?.printerModel ?? null;
      } else if (fileFormatQuery) {
        fileFormat = fileFormatQuery as FileFormatType;
      } else {
        throw new BadRequestException("One of fileStorageId, jobId, or fileFormat is required");
      }

      const allPrinters = await this.printerCache.listCachedPrinters(true);

      // We need the firmware cache warm whenever:
      //   - the file is .bgcode (gate legacy 8-bit boards)
      //   - the slicer wrote a printerModel (gate cross-family submissions
      //     like a Mini-sliced gcode landing on an XL)
      const fileFamily = getPrusaPrinterFamily(slicerTargetModel);
      const needsModelCheck = fileFormat === "bgcode" || fileFamily !== null;
      if (needsModelCheck) {
        await Promise.all(
          allPrinters
            .filter((p) => p.printerType === PrusaLinkType && p.enabled)
            .map((p) => this.printerFirmwareCache.getOrFetch(p.id).catch(() => null)),
        );
      }

      const maintenancePrinterIds = await this.printerMaintenanceLogService.getActivePrinterIdsSet(
        allPrinters.map((p) => p.id),
      );

      const enriched = allPrinters.map((printer) => {
        if (maintenancePrinterIds.has(printer.id)) {
          return {
            printer,
            compatible: false,
            reason: "Printer has pending maintenance and is not ready to print. Complete the maintenance first.",
          };
        }

        const typeReason = getIncompatibilityReason(printer.printerType as PrinterType, fileFormat);
        if (typeReason) {
          return { printer, compatible: false, reason: typeReason };
        }

        if (needsModelCheck && printer.printerType === PrusaLinkType) {
          const info = this.printerFirmwareCache.getCachedInfoSync(printer.id);
          if (fileFormat === "bgcode" && info?.supportsBgcode === false) {
            const modelLabel = info.model ?? "this PrusaLink model";
            return {
              printer,
              compatible: false,
              reason: `Binary G-code (.bgcode) is only supported by 32-bit Buddy boards (MK4, MK3.9, MK3.5, XL, MINI+, Core One). ${modelLabel} runs Marlin on a legacy 8-bit board and cannot decode .bgcode — upload as plain .gcode instead.`,
            };
          }

          // Cross-family guard: gcode sliced for a MINI shouldn't queue on an
          // XL even though both are PrusaLink. We only apply this when the
          // slicer wrote a model AND we successfully detected the printer's
          // model — otherwise fail open so we don't false-positive on files
          // sliced by tools that don't fill `printer_model`.
          if (slicerTargetModel && !arePrusaModelsCompatible(slicerTargetModel, info?.model)) {
            const printerLabel = info?.model ?? "this printer";
            return {
              printer,
              compatible: false,
              reason: `This file was sliced for ${slicerTargetModel}, but ${printerLabel} is a different model family. Re-slice for ${printerLabel} or pick a printer in the ${getPrusaPrinterFamily(slicerTargetModel)} family.`,
            };
          }
        }

        return { printer, compatible: true, reason: null };
      });

      res.send({
        fileFormat: fileFormat ?? null,
        fileName: resolvedFileName ?? null,
        slicerTargetModel,
        slicerTargetFamily: getPrusaPrinterFamily(slicerTargetModel),
        compatible: enriched.filter((p) => p.compatible).map((p) => p.printer),
        incompatible: enriched
          .filter((p) => !p.compatible)
          .map((p) => ({ ...p.printer, incompatibilityReason: p.reason })),
      });
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof BadRequestException) {
        throw error;
      }
      this.logger.error(`Failed to compute compatible printers: ${error}`);
      res.status(500).send({ error: "Failed to compute compatible printers" });
    }
  }

  /**
   * Files available to enqueue on a specific printer, sourced from File
   * Storage. Filters by printer compatibility so the picker only shows
   * actually-printable files. Honors the same folder-navigation contract as
   * GET /file-storage (`folderPath`, `recursive`).
   *
   * This endpoint is the "primary" source the printer view should hit before
   * falling back to the printer's USB stick. The USB endpoint
   * (GET /printer-files/:id) is the secondary source for files that haven't
   * been uploaded to File Storage yet.
   */
  @GET()
  @route("/:printerId/available-files")
  @before([ParamId("printerId")])
  async getAvailableFilesForPrinter(req: Request, res: Response) {
    const printerId = req.local.printerId;
    const requestedFolder = FileStorageFolderService.normalisePath((req.query.folderPath as string) ?? null);
    const recursive = (req.query.recursive as string) === "true";

    const printer = await this.printerCache.getCachedPrinterOrThrowAsync(printerId);

    // PrusaLink + .bgcode requires the firmware cache so we can tell MK4 from
    // MK3S. Warm it once up-front so we don't fetch per file.
    if (printer.printerType === PrusaLinkType) {
      await this.printerFirmwareCache.getOrFetch(printerId).catch(() => null);
    }
    const firmwareInfo =
      printer.printerType === PrusaLinkType ? this.printerFirmwareCache.getCachedInfoSync(printerId) : null;

    const allFiles = await this.fileStorageService.listAllFiles();
    const folders = await this.fileStorageFolderService.listChildren(requestedFolder);

    // Scope to the folder the user is browsing.
    const inFolder = allFiles.filter((file) => {
      const fp: string | null = file.metadata?._folderPath ?? null;
      if (recursive) {
        if (requestedFolder === null) return true;
        return fp === requestedFolder || (fp ?? "").startsWith(requestedFolder + "/");
      }
      return (fp ?? null) === requestedFolder;
    });

    let incompatibleCount = 0;
    const compatibleFiles = inFolder.filter((file) => {
      const fileFormat = file.metadata?.fileFormat as FileFormatType | undefined;
      const typeReason = getIncompatibilityReason(printer.printerType as PrinterType, fileFormat);
      if (typeReason) {
        incompatibleCount += 1;
        return false;
      }
      // .bgcode on a legacy MK3S over the PrusaLink shim — same gate as the
      // queue submission path.
      if (fileFormat === "bgcode" && printer.printerType === PrusaLinkType && firmwareInfo?.supportsBgcode === false) {
        incompatibleCount += 1;
        return false;
      }
      // Cross-family guard for PrusaLink printers: hide files sliced for a
      // different family (e.g. a MINI gcode mustn't show up on an XL).
      if (printer.printerType === PrusaLinkType) {
        const slicerTarget = (file.metadata?.printerModel as string | null) ?? null;
        if (slicerTarget && !arePrusaModelsCompatible(slicerTarget, firmwareInfo?.model)) {
          incompatibleCount += 1;
          return false;
        }
      }
      return true;
    });

    res.send({
      printerId,
      printerName: printer.name,
      printerType: printer.printerType,
      printerModel: firmwareInfo?.model ?? null,
      folderPath: requestedFolder ?? "/",
      folders: folders.map((f) => ({ path: f.path, name: f.name, createdAt: f.createdAt })),
      files: compatibleFiles.map((file) => {
        const thumbnails = (file.metadata?._thumbnails || []).map((thumb: any) => ({
          index: thumb.index,
          width: thumb.width,
          height: thumb.height,
          format: thumb.format,
          size: thumb.size,
        }));
        return {
          fileStorageId: file.fileStorageId,
          fileName: file.fileName,
          // User-facing display name preserved from upload. Falls back to the
          // stored fileName for legacy rows without metadata.
          originalFileName: file.metadata?._originalFileName ?? file.fileName,
          fileFormat: file.fileFormat,
          fileSize: file.fileSize,
          fileHash: file.fileHash,
          createdAt: file.createdAt,
          folderPath: file.metadata?._folderPath ?? null,
          // Surface the analysed metadata so the picker can show print time /
          // filament without an extra round-trip.
          estimatedTimeSeconds: file.metadata?.gcodePrintTimeSeconds ?? null,
          filamentGrams: file.metadata?.filamentUsedGrams ?? null,
          totalLayers: file.metadata?.totalLayers ?? null,
          thumbnails,
        };
      }),
      totalCount: compatibleFiles.length,
      incompatibleCount,
      // Hint for the frontend: File Storage is the preferred picker source.
      primarySource: "storage",
      secondarySource: "usb",
    });
  }

  @GET()
  @route("/:printerId")
  @before([ParamId("printerId")])
  async getQueue(req: Request, res: Response) {
    const printerId = req.local.printerId;

    try {
      const queue = await this.printQueueService.getQueue(printerId);
      res.send({
        printerId,
        queue,
        count: queue.length,
      });
    } catch (error) {
      this.logger.error(`Failed to get queue for printer ${printerId}: ${error}`);
      res.status(500).send({ error: "Failed to get queue" });
    }
  }

  @POST()
  @route("/:printerId/add/:jobId")
  @before([ParamId("printerId"), ParamId("jobId")])
  async addToQueue(req: Request, res: Response) {
    const printerId = req.local.printerId;
    const jobId = req.local.jobId;
    const position = req.body.position === undefined ? undefined : Number.parseInt(req.body.position);

    try {
      await this.printQueueService.addToQueue(printerId, jobId, position);
      const queue = await this.printQueueService.getQueue(printerId);

      res.send({
        message: "Job added to queue",
        printerId,
        jobId,
        position,
        queue,
      });
    } catch (error) {
      this.logger.error(`Failed to add job ${jobId} to queue: ${error}`);
      res.status(500).send({
        error: "Failed to add to queue",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  @PUT()
  @route("/:printerId/reorder")
  @before([ParamId("printerId")])
  async reorderQueue(req: Request, res: Response) {
    const printerId = req.local.printerId;
    const jobIds = req.body.jobIds;

    if (!Array.isArray(jobIds)) {
      res.status(400).send({ error: "jobIds must be an array" });
      return;
    }

    try {
      await this.printQueueService.reorderQueue(printerId, jobIds);
      const queue = await this.printQueueService.getQueue(printerId);

      res.send({
        message: "Queue reordered",
        printerId,
        queue,
      });
    } catch (error) {
      this.logger.error(`Failed to reorder queue for printer ${printerId}: ${error}`);
      res.status(500).send({
        error: "Failed to reorder queue",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  @DELETE()
  @route("/:printerId/clear")
  @before([ParamId("printerId")])
  async clearQueue(req: Request, res: Response) {
    const printerId = req.local.printerId;

    try {
      await this.printQueueService.clearQueue(printerId);

      res.send({
        message: "Queue cleared",
        printerId,
      });
    } catch (error) {
      this.logger.error(`Failed to clear queue for printer ${printerId}: ${error}`);
      res.status(500).send({
        error: "Failed to clear queue",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  @DELETE()
  @route("/:printerId/:jobId")
  @before([ParamId("printerId"), ParamId("jobId")])
  async removeFromQueue(req: Request, res: Response) {
    const printerId = req.local.printerId;
    const jobId = req.local.jobId;

    try {
      await this.printQueueService.removeFromQueue(jobId);
      const queue = await this.printQueueService.getQueue(printerId);

      res.send({
        message: "Job removed from queue",
        printerId,
        jobId,
        queue,
      });
    } catch (error) {
      this.logger.error(`Failed to remove job ${jobId} from queue: ${error}`);
      res.status(500).send({
        error: "Failed to remove from queue",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  @GET()
  @route("/:printerId/next")
  @before([ParamId("printerId")])
  async getNextInQueue(req: Request, res: Response) {
    const printerId = req.local.printerId;

    try {
      const nextJob = await this.printQueueService.getNextInQueue(printerId);

      res.send({
        printerId,
        nextJob,
      });
    } catch (error) {
      this.logger.error(`Failed to get next job for printer ${printerId}: ${error}`);
      res.status(500).send({ error: "Failed to get next job" });
    }
  }

  @POST()
  @route("/:printerId/process")
  @before([ParamId("printerId")])
  async processQueue(req: Request, res: Response) {
    const printerId = req.local.printerId;

    try {
      const nextJob = await this.printQueueService.processQueue(printerId);

      if (!nextJob) {
        res.send({
          message: "Queue is empty",
          printerId,
          nextJob: null,
        });
        return;
      }

      res.send({
        message: "Submitted next job in queue to printer",
        printerId,
        nextJob: {
          id: nextJob.id,
          fileName: nextJob.fileName,
          status: nextJob.status,
        },
      });
    } catch (error) {
      // BadRequest (e.g. printer offline / in maintenance) gets a 4xx so the
      // UI can show the actual reason instead of a generic "internal error".
      if (error instanceof BadRequestException) {
        res.status(400).send({
          error: "Cannot process queue",
          message: error.message,
        });
        return;
      }
      this.logger.error(`Failed to process queue for printer ${printerId}: ${error}`);
      res.status(500).send({
        error: "Failed to process queue",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  @POST()
  @route("/:printerId/from-file")
  @before([ParamId("printerId")])
  async createJobFromFile(req: Request, res: Response) {
    const printerId = req.local.printerId;
    const { fileStorageId, addToQueue = true, position } = req.body;

    if (!fileStorageId) {
      res.status(400).send({ error: "fileStorageId is required" });
      return;
    }

    try {
      const fileExists = await this.fileStorageService.fileExists(fileStorageId);
      if (!fileExists) {
        throw new NotFoundException("File not found in storage");
      }

      const metadata = await this.fileStorageService.loadMetadata(fileStorageId);
      if (!metadata) {
        res.status(400).send({ error: "File has no metadata. Please analyze the file first." });
        return;
      }

      const printer = await this.printerCache.getCachedPrinterOrThrowAsync(printerId);

      const inMaintenance = await this.printerMaintenanceLogService.hasActiveByPrinterId(printerId);
      if (inMaintenance) {
        res.status(400).send({
          error: "Printer has pending maintenance",
          message: `Printer ${printer.name} has pending maintenance and cannot accept print jobs. Complete the maintenance first.`,
        });
        return;
      }

      // Defence in depth: even if a stale UI lets the user pick an incompatible
      // printer, refuse server-side so we don't queue a file the printer can't
      // ever run (e.g. .bgcode on OctoPrint, .gcode on Bambu).
      const fileFormat = metadata.fileFormat as FileFormatType | undefined;
      const incompatibilityReason = getIncompatibilityReason(printer.printerType as PrinterType, fileFormat);
      if (incompatibilityReason) {
        res.status(400).send({
          error: "Incompatible printer for this file",
          message: incompatibilityReason,
          fileFormat: metadata.fileFormat ?? null,
          printerType: printer.printerType,
        });
        return;
      }

      // .bgcode requires Buddy firmware on a 32-bit board. Block submission to
      // a legacy MK2.x/MK3/MK3S even though they show up as PrusaLink-typed.
      // Also catches the cross-family case (e.g. a MINI-sliced file landing
      // on an XL): same printer type, different motion/heat profiles.
      if (printer.printerType === PrusaLinkType) {
        const info = await this.printerFirmwareCache.getOrFetch(printerId);
        if (fileFormat === "bgcode" && info.supportsBgcode === false) {
          const modelLabel = info.model ?? "this PrusaLink model";
          res.status(400).send({
            error: "Incompatible printer for this file",
            message: `Binary G-code (.bgcode) cannot be printed on ${modelLabel}. Re-slice as plain .gcode or pick a Buddy-firmware printer (MK4, MK3.9, MK3.5, XL, MINI+, Core One).`,
            fileFormat: metadata.fileFormat ?? null,
            printerType: printer.printerType,
            printerModel: info.model ?? null,
          });
          return;
        }

        const slicerTarget = (metadata.printerModel as string | null) ?? null;
        if (slicerTarget && !arePrusaModelsCompatible(slicerTarget, info.model)) {
          const printerLabel = info.model ?? "this printer";
          res.status(400).send({
            error: "Incompatible printer for this file",
            message: `This file was sliced for ${slicerTarget}, but ${printerLabel} is a different model family. Re-slice for ${printerLabel} or pick a printer in the ${getPrusaPrinterFamily(slicerTarget)} family.`,
            fileFormat: metadata.fileFormat ?? null,
            printerType: printer.printerType,
            printerModel: info.model ?? null,
            slicerTargetModel: slicerTarget,
            slicerTargetFamily: getPrusaPrinterFamily(slicerTarget),
          });
          return;
        }
      }

      const job = await this.printJobService.createPendingJob(
        printerId,
        metadata._originalFileName || metadata.fileName || "Unknown",
        metadata,
        printer.name,
      );

      job.fileStorageId = fileStorageId;
      job.fileHash = metadata._fileHash;
      job.analysisState = "ANALYZED";
      job.analyzedAt = new Date();

      if (metadata.fileFormat) {
        job.fileFormat = metadata.fileFormat;
      }

      await this.printJobService.updateJob(job);

      if (addToQueue) {
        await this.printQueueService.addToQueue(printerId, job.id, position);
      }

      this.logger.log(
        `Created job ${job.id} from file storage ${fileStorageId} for printer ${printerId}${addToQueue ? " and added to queue" : ""}`,
      );

      res.send({
        id: job.id,
        printerId: job.printerId,
        printerName: job.printerName,
        fileName: job.fileName,
        fileStorageId: job.fileStorageId,
        status: job.status,
        analysisState: job.analysisState,
        createdAt: job.createdAt,
        addedToQueue: addToQueue,
      });
    } catch (error) {
      this.logger.error(`Failed to create job from file ${fileStorageId}: ${error}`);
      res.status(500).send({ error: "Failed to create job from file" });
    }
  }

  /**
   * Queue a file that already lives on the printer's USB / firmware storage.
   * Counterpart to `from-file` for the case where the file was never uploaded
   * to File Storage. We don't have analyzed metadata for these files so the
   * job is created as NOT_ANALYZED with a minimal metadata stub; when its turn
   * comes, the queue service calls `startPrint(path)` instead of re-uploading.
   *
   * Body:
   *   - filePath:    printer-addressable path returned by GET /printer-files/:id
   *   - displayName: optional friendly label (PrusaLink FAT 8.3 displayName)
   *   - fileSize:    optional, surfaced from the printer's listing
   *   - addToQueue:  default true
   *   - position:    optional explicit queue position
   */
  @POST()
  @route("/:printerId/from-usb-file")
  @before([ParamId("printerId")])
  async createJobFromUsbFile(req: Request, res: Response) {
    const printerId = req.local.printerId;
    const { filePath, displayName, fileSize, addToQueue = true, position } = req.body ?? {};

    if (typeof filePath !== "string" || filePath.trim().length === 0) {
      res.status(400).send({ error: "filePath is required" });
      return;
    }

    try {
      const printer = await this.printerCache.getCachedPrinterOrThrowAsync(printerId);

      const inMaintenance = await this.printerMaintenanceLogService.hasActiveByPrinterId(printerId);
      if (inMaintenance) {
        res.status(400).send({
          error: "Printer has pending maintenance",
          message: `Printer ${printer.name} has pending maintenance and cannot accept print jobs. Complete the maintenance first.`,
        });
        return;
      }

      const fileName = displayName?.trim() || filePath.split("/").pop() || filePath;

      const ext = (fileName.split(".").pop() ?? "").toLowerCase();
      const fileFormat: FileFormatType | null =
        ext === "gcode" ? "gcode" : ext === "bgcode" ? "bgcode" : ext === "3mf" ? "3mf" : null;

      if (!fileFormat) {
        res.status(400).send({
          error: "Unsupported file format",
          message: `Cannot determine print format from "${fileName}". Supported extensions: .gcode, .bgcode, .3mf.`,
        });
        return;
      }

      const incompatibilityReason = getIncompatibilityReason(printer.printerType as PrinterType, fileFormat);
      if (incompatibilityReason) {
        res.status(400).send({
          error: "Incompatible printer for this file",
          message: incompatibilityReason,
          fileFormat,
          printerType: printer.printerType,
        });
        return;
      }

      if (printer.printerType === PrusaLinkType && fileFormat === "bgcode") {
        const info = await this.printerFirmwareCache.getOrFetch(printerId);
        if (info.supportsBgcode === false) {
          const modelLabel = info.model ?? "this PrusaLink model";
          res.status(400).send({
            error: "Incompatible printer for this file",
            message: `Binary G-code (.bgcode) cannot be printed on ${modelLabel}. Re-slice as plain .gcode or pick a Buddy-firmware printer (MK4, MK3.9, MK3.5, XL, MINI+, Core One).`,
            fileFormat,
            printerType: printer.printerType,
            printerModel: info.model ?? null,
          });
          return;
        }
      }

      // Minimal metadata stub — the file lives on the printer so we can't
      // analyze it without first downloading it. createPendingJob() will mark
      // the job as NOT_ANALYZED because all the analysis fields are null.
      const metadata: PrintJobMetadata = {
        fileName,
        fileFormat,
        fileSize: typeof fileSize === "number" ? fileSize : undefined,
        gcodePrintTimeSeconds: null,
        nozzleDiameterMm: null,
        filamentDiameterMm: null,
        filamentDensityGramsCm3: null,
        filamentUsedMm: null,
        filamentUsedCm3: null,
        filamentUsedGrams: null,
        totalFilamentUsedGrams: null,
        layerHeight: null,
        firstLayerHeight: null,
        bedTemperature: null,
        nozzleTemperature: null,
        fillDensity: null,
        filamentType: null,
        printerModel: null,
        slicerVersion: null,
        maxLayerZ: null,
        totalLayers: null,
      } as PrintJobMetadata;

      const job = await this.printJobService.createPendingJob(printerId, fileName, metadata, printer.name);

      job.usbFilePath = filePath;
      job.usbDisplayName = displayName?.trim() || null;
      job.fileFormat = fileFormat;
      if (typeof fileSize === "number") {
        job.fileSize = fileSize;
      }
      await this.printJobService.updateJob(job);

      if (addToQueue) {
        await this.printQueueService.addToQueue(printerId, job.id, position);
      }

      this.logger.log(
        `Created job ${job.id} from USB file ${filePath} for printer ${printerId}${addToQueue ? " and added to queue" : ""}`,
      );

      res.send({
        id: job.id,
        printerId: job.printerId,
        printerName: job.printerName,
        fileName: job.fileName,
        usbFilePath: job.usbFilePath,
        usbDisplayName: job.usbDisplayName,
        fileFormat: job.fileFormat,
        status: job.status,
        analysisState: job.analysisState,
        createdAt: job.createdAt,
        addedToQueue: addToQueue,
      });
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) {
        throw error;
      }
      this.logger.error(`Failed to create job from USB file ${filePath}: ${error}`);
      res.status(500).send({ error: "Failed to create job from USB file" });
    }
  }

  @POST()
  @route("/:printerId/submit/:jobId")
  @before([ParamId("printerId"), ParamId("jobId")])
  async submitToPrinter(req: Request, res: Response) {
    const printerId = req.local.printerId;
    const jobId = req.local.jobId;

    try {
      await this.printQueueService.submitToPrinter(printerId, jobId);

      res.send({
        message: "Job submitted to printer for printing",
        printerId,
        jobId,
      });
    } catch (error) {
      this.logger.error(`Failed to submit job ${jobId} to printer ${printerId}: ${error}`);
      res.status(500).send({
        error: "Failed to submit job to printer",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
}
