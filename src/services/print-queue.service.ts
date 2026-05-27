import { Repository, Not, IsNull } from "typeorm";
import { PrintJob } from "@/entities/print-job.entity";
import { Printer } from "@/entities/printer.entity";
import EventEmitter2 from "eventemitter2";
import type { ILoggerFactory } from "@/handlers/logger-factory";
import { TypeormService } from "@/services/typeorm/typeorm.service";
import { LoggerService } from "@/handlers/logger";
import { PrinterApiFactory } from "@/services/printer-api.factory";
import { FileStorageService } from "@/services/file-storage.service";
import { PrinterSocketStore } from "@/state/printer-socket.store";
import { SOCKET_STATE } from "@/shared/dtos/socket-state.type";
import { API_STATE } from "@/shared/dtos/api-state.type";
import { captureException } from "@sentry/node";
import { PrinterMaintenanceLogService } from "@/services/orm/printer-maintenance-log.service";
import { BadRequestException } from "@/exceptions/runtime.exceptions";

// Subfolder on the printer's own storage where File-Storage prints are uploaded.
// Keeps print copies out of the printer's root and lets us clean them up: the
// file from the previous print is deleted right before the next one is uploaded
// (deleting at completion time is unreliable on PrusaLink, which keeps the
// just-finished file "selected" and answers 409 until the user dismisses it).
export const PRINTER_TEMP_FOLDER = "fdm-monster-temp";

export interface QueuedJob {
  id: number;
  fileName: string;
  queuePosition: number;
  status: string;
  estimatedTimeSeconds?: number;
  filamentGrams?: number | number[];
  createdAt: Date;
  // Surfaced so the UI can render the next-up item richly (thumbnail
  // preview, layer/filament metadata) without an extra round-trip per
  // queue row.
  fileStorageId?: string | null;
  // Set when the job points at a file living on the printer's USB
  // storage (not in File Storage). The UI uses these to fetch a
  // firmware-side thumbnail instead of the file-storage one.
  usbFilePath?: string | null;
  usbDisplayName?: string | null;
  fileFormat?: string | null;
  fileSize?: number | null;
  thumbnails?: Array<{ index: number; width: number; height: number; format: string; size: number }>;
  layerHeight?: number | null;
  totalLayers?: number | null;
  printerModel?: string | null;
  filamentType?: string | null;
}

export interface IPrintQueueService {
  addToQueue(printerId: number, jobId: number, position?: number): Promise<void>;

  removeFromQueue(jobId: number): Promise<void>;

  getQueue(printerId: number): Promise<QueuedJob[]>;

  getGlobalQueuePaged(page: number, pageSize: number): Promise<[PrintJob[], number]>;

  getNextInQueue(printerId: number): Promise<PrintJob | null>;

  reorderQueue(printerId: number, jobIds: number[]): Promise<void>;

  clearQueue(printerId: number): Promise<void>;

  processQueue(printerId: number): Promise<PrintJob | null>;
}

/**
 * Simplified service for managing print job queues per printer
 */
export class PrintQueueService implements IPrintQueueService {
  printJobRepository: Repository<PrintJob>;
  printerRepository: Repository<Printer>;
  eventEmitter2: EventEmitter2;
  private readonly logger: LoggerService;
  // Printer-side paths of temp files left by each printer's File-Storage prints,
  // pending deletion. Cleared as each is deleted before a subsequent upload; a
  // failed delete stays in the set and is retried on the next print.
  private readonly pendingTempFiles = new Map<number, Set<string>>();

  constructor(
    loggerFactory: ILoggerFactory,
    typeormService: TypeormService,
    eventEmitter2: EventEmitter2,
    private readonly printerApiFactory: PrinterApiFactory,
    private readonly fileStorageService: FileStorageService,
    private readonly printerSocketStore: PrinterSocketStore,
    private readonly printerMaintenanceLogService: PrinterMaintenanceLogService,
  ) {
    this.printJobRepository = typeormService.getDataSource().getRepository(PrintJob);
    this.printerRepository = typeormService.getDataSource().getRepository(Printer);
    this.eventEmitter2 = eventEmitter2;
    this.logger = loggerFactory(PrintQueueService.name);

    this.eventEmitter2.on(
      "printQueue.jobSubmitted",
      (event: {
        printerId: number;
        jobId: number;
        fileName: string;
        fileStorageId?: string;
        usbFilePath?: string;
        queuePosition?: number | null;
      }) => {
        this.handleJobSubmission(
          event.printerId,
          event.jobId,
          event.fileName,
          event.fileStorageId,
          event.usbFilePath,
          event.queuePosition,
        ).catch((error) => {
          this.logger.error(`Failed to handle job submission for job ${event.jobId}`, error);
          captureException(error);
        });
      },
    );
  }

  private isPrinterConnected(printerId: number): { connected: boolean; reason?: string } {
    const socket = this.printerSocketStore.getPrinterSocket(printerId);

    if (!socket) {
      return { connected: false, reason: "No socket connection found" };
    }

    const socketState = socket.socketState;
    const apiState = socket.apiState;

    if (socketState !== SOCKET_STATE.opened && socketState !== SOCKET_STATE.authenticated) {
      return { connected: false, reason: `Socket not connected (state: ${socketState})` };
    }

    if (apiState !== API_STATE.responding) {
      return { connected: false, reason: `Printer not responding (API state: ${apiState})` };
    }

    return { connected: true };
  }

  async addToQueue(printerId: number, jobId: number, position?: number): Promise<void> {
    const job = await this.printJobRepository.findOne({ where: { id: jobId } });
    if (!job) {
      throw new Error(`Print job ${jobId} not found`);
    }

    this.ensurePrinterAssignment(job, printerId);
    await this.ensurePrinterNotInMaintenance(printerId);

    if (position === undefined || position === null) {
      const maxPosition = await this.getMaxQueuePosition(printerId);
      job.queuePosition = (maxPosition ?? -1) + 1;
    } else {
      await this.shiftQueuePositions(printerId, position);
      job.queuePosition = position;
    }

    job.status = "QUEUED";
    await this.printJobRepository.save(job);

    this.logger.log(`Added job ${jobId} to printer ${printerId} queue at position ${job.queuePosition}`);
    this.eventEmitter2.emit("printQueue.jobAdded", {
      printerId,
      jobId,
      position: job.queuePosition,
    });
  }

  async removeFromQueue(jobId: number): Promise<void> {
    const job = await this.printJobRepository.findOne({ where: { id: jobId } });
    if (!job) {
      throw new Error(`Print job ${jobId} not found`);
    }

    const printerId = job.printerId;
    const oldPosition = job.queuePosition;

    job.queuePosition = null;
    if (job.status === "QUEUED") {
      job.status = "PENDING";
    }
    await this.printJobRepository.save(job);

    if (oldPosition !== null && printerId) {
      await this.compactQueuePositions(printerId, oldPosition);
    }

    this.logger.log(`Removed job ${jobId} from queue`);
    this.eventEmitter2.emit("printQueue.jobRemoved", {
      printerId,
      jobId,
    });
  }

  async getQueue(printerId: number): Promise<QueuedJob[]> {
    const jobs = await this.printJobRepository.find({
      where: {
        printerId,
        status: "QUEUED",
        queuePosition: Not(IsNull()),
      },
      order: { queuePosition: "ASC" },
    });

    return jobs.map((j) => {
      const md = (j.metadata as any) ?? {};
      const thumbnails = Array.isArray(md._thumbnails)
        ? md._thumbnails.map((t: any) => ({
            index: t.index,
            width: t.width,
            height: t.height,
            format: t.format,
            size: t.size,
          }))
        : Array.isArray((j as any).thumbnails)
          ? (j as any).thumbnails
          : undefined;
      return {
        id: j.id,
        fileName: j.fileName,
        queuePosition: j.queuePosition!,
        status: j.status,
        estimatedTimeSeconds: md.gcodePrintTimeSeconds,
        filamentGrams: md.filamentUsedGrams,
        createdAt: j.createdAt,
        // Extra fields so the UI can render a "next up" hero card
        // (thumbnail + metadata) without per-row fetches.
        fileStorageId: j.fileStorageId ?? null,
        usbFilePath: (j as any).usbFilePath ?? null,
        usbDisplayName: (j as any).usbDisplayName ?? null,
        fileFormat: j.fileFormat ?? null,
        fileSize: j.fileSize ?? null,
        thumbnails,
        layerHeight: md.layerHeight ?? null,
        totalLayers: md.totalLayers ?? null,
        printerModel: md.printerModel ?? null,
        filamentType: md.filamentType ?? null,
      };
    });
  }

  async getGlobalQueuePaged(page: number, pageSize: number): Promise<[PrintJob[], number]> {
    const skip = (page - 1) * pageSize;

    return await this.printJobRepository.findAndCount({
      where: { status: "QUEUED" },
      order: {
        printerId: "ASC",
        queuePosition: "ASC",
      },
      relations: ["printer"],
      take: pageSize,
      skip: skip,
    });
  }

  async getNextInQueue(printerId: number): Promise<PrintJob | null> {
    return this.printJobRepository.findOne({
      where: {
        printerId,
        status: "QUEUED",
        queuePosition: Not(IsNull()),
      },
      order: { queuePosition: "ASC" },
    });
  }

  async reorderQueue(printerId: number, jobIds: number[]): Promise<void> {
    for (let i = 0; i < jobIds.length; i++) {
      const job = await this.printJobRepository.findOne({ where: { id: jobIds[i] } });
      if (job?.printerId === printerId) {
        job.queuePosition = i;
        await this.printJobRepository.save(job);
      }
    }

    this.logger.log(`Reordered queue for printer ${printerId}`);
    this.eventEmitter2.emit("printQueue.reordered", { printerId });
  }

  async clearQueue(printerId: number): Promise<void> {
    const jobs = await this.printJobRepository.find({
      where: {
        printerId,
        status: "QUEUED",
      },
    });

    for (const job of jobs) {
      job.status = "PENDING";
      job.queuePosition = null;
      await this.printJobRepository.save(job);
    }

    this.logger.log(`Cleared queue for printer ${printerId} (${jobs.length} jobs)`);
    this.eventEmitter2.emit("printQueue.cleared", { printerId });
  }

  async processQueue(printerId: number): Promise<PrintJob | null> {
    const nextJob = await this.getNextInQueue(printerId);

    if (!nextJob) {
      this.logger.log(`No jobs in queue for printer ${printerId}`);
      return null;
    }

    // Refuse to submit when the printer isn't actually reachable — the
    // submission would fail mid-upload and flip the job to FAILED, forcing the
    // user to requeue. Better to leave the job in queue and surface the reason.
    const connectivity = this.isPrinterConnected(printerId);
    if (!connectivity.connected) {
      throw new BadRequestException(
        `Cannot process queue: printer ${printerId} is not ready. ${connectivity.reason ?? ""}`.trim(),
      );
    }

    this.logger.log(`Processing queue: next job is ${nextJob.id} (${nextJob.fileName})`);

    // Actually push the file to the printer and start it. Previous behaviour
    // only fired an event with no listener, so "Process next" was a silent
    // no-op for the user.
    await this.submitToPrinter(printerId, nextJob.id);

    return nextJob;
  }

  private async ensurePrinterNotInMaintenance(printerId: number): Promise<void> {
    const inMaintenance = await this.printerMaintenanceLogService.hasActiveByPrinterId(printerId);
    if (inMaintenance) {
      throw new BadRequestException(
        `Printer ${printerId} has pending maintenance and cannot accept print jobs. Complete the maintenance first.`,
      );
    }
  }

  private ensurePrinterAssignment(job: PrintJob, printerId: number): void {
    if (!job.printerId) {
      job.printerId = printerId;
    } else if (job.printerId !== printerId) {
      throw new Error(`Job ${job.id} belongs to printer ${job.printerId}, cannot submit to printer ${printerId}`);
    }
  }

  private async getMaxQueuePosition(printerId: number): Promise<number | null> {
    const result = await this.printJobRepository
      .createQueryBuilder("job")
      .select("MAX(job.queuePosition)", "max")
      .where("job.printerId = :printerId", { printerId })
      .getRawOne();

    return result?.max ?? null;
  }

  private async shiftQueuePositions(printerId: number, fromPosition: number): Promise<void> {
    await this.printJobRepository
      .createQueryBuilder()
      .update(PrintJob)
      .set({ queuePosition: () => "queuePosition + 1" })
      .where("printerId = :printerId", { printerId })
      .andWhere("queuePosition >= :fromPosition", { fromPosition })
      .execute();
  }

  private async compactQueuePositions(printerId: number, removedPosition: number): Promise<void> {
    await this.printJobRepository
      .createQueryBuilder()
      .update(PrintJob)
      .set({ queuePosition: () => "queuePosition - 1" })
      .where("printerId = :printerId", { printerId })
      .andWhere("queuePosition > :removedPosition", { removedPosition })
      .execute();
  }

  async submitToPrinter(printerId: number, jobId: number): Promise<void> {
    const job = await this.printJobRepository.findOne({ where: { id: jobId } });

    if (!job) {
      throw new Error(`Print job ${jobId} not found`);
    }

    this.ensurePrinterAssignment(job, printerId);
    await this.ensurePrinterNotInMaintenance(printerId);

    const queuePosition = job.queuePosition;
    if (job.queuePosition !== null) {
      const oldPosition = job.queuePosition;
      job.queuePosition = null;
      await this.compactQueuePositions(printerId, oldPosition);
    }

    job.status = "PRINTING";
    job.startedAt = new Date();
    await this.printJobRepository.save(job);

    this.logger.log(`Submitting job ${jobId} (${job.fileName}) to printer ${printerId}`);
    this.eventEmitter2.emit("printQueue.jobSubmitted", {
      printerId,
      jobId: job.id,
      fileName: job.fileName,
      fileStorageId: job.fileStorageId,
      usbFilePath: job.usbFilePath,
      queuePosition,
    });
  }

  private async handleJobSubmission(
    printerId: number,
    jobId: number,
    fileName: string,
    fileStorageId: string | null | undefined,
    usbFilePath: string | null | undefined,
    queuePosition?: number | null,
  ): Promise<void> {
    this.logger.log(`Handling job submission for job ${jobId} on printer ${printerId}`);

    try {
      const printerApi = this.printerApiFactory.getById(printerId);

      if (usbFilePath) {
        // File already lives on the printer's storage — just tell the firmware
        // to start it. Mirrors the per-segment encoding the legacy USB-print
        // controller uses so PrusaLink/OctoPrint accept paths with spaces.
        const encodedPath = usbFilePath.split("/").map(encodeURIComponent).join("/");
        this.logger.log(`Starting print of USB file ${usbFilePath} on printer ${printerId}`);
        await printerApi.startPrint(encodedPath);
      } else if (fileStorageId) {
        // Clean up temp files from this printer's previous print(s) before we
        // upload the next one — by now the printer has moved on so they're no
        // longer "selected"/in use and the delete succeeds.
        await this.cleanupPendingTempFiles(printerApi, printerId);

        // Ensure the temp folder exists (no-op if the printer type or firmware
        // doesn't support folder creation).
        if (typeof printerApi.createFolder === "function") {
          try {
            await printerApi.createFolder(PRINTER_TEMP_FOLDER);
          } catch (e) {
            this.logger.debug(
              `Could not pre-create temp folder on printer ${printerId} (continuing): ${
                e instanceof Error ? e.message : e
              }`,
            );
          }
        }

        const fileSize = this.fileStorageService.getFileSize(fileStorageId);
        const fileStream = this.fileStorageService.readFileStream(fileStorageId);

        this.logger.log(`Uploading file ${fileName} to printer ${printerId} (temp folder) and starting print`);
        await printerApi.uploadFile({
          stream: fileStream,
          fileName,
          contentLength: fileSize,
          startPrint: true,
          targetPath: PRINTER_TEMP_FOLDER,
        });

        // Remember where it landed so the next print can delete it.
        let pending = this.pendingTempFiles.get(printerId);
        if (!pending) {
          pending = new Set<string>();
          this.pendingTempFiles.set(printerId, pending);
        }
        pending.add(`${PRINTER_TEMP_FOLDER}/${fileName}`);
      } else {
        throw new Error(`Job ${jobId} has neither fileStorageId nor usbFilePath - cannot submit to printer`);
      }
      this.logger.log(`Successfully submitted job ${jobId} to printer ${printerId}`);

      if (queuePosition !== null && queuePosition !== undefined) {
        const job = await this.printJobRepository.findOne({ where: { id: jobId } });
        if (job?.queuePosition === queuePosition) {
          job.queuePosition = null;
          await this.printJobRepository.save(job);
          await this.compactQueuePositions(printerId, queuePosition);
          this.logger.log(`Removed job ${jobId} from queue after successful submission`);
        }
      }
    } catch (error) {
      this.logger.error(`Failed to submit job ${jobId} to printer ${printerId}`, error);

      try {
        const job = await this.printJobRepository.findOne({ where: { id: jobId } });
        if (job) {
          job.status = "FAILED";
          job.statusReason = `Print submission failed: ${error instanceof Error ? error.message : "Unknown error"}`;
          job.endedAt = new Date();
          await this.printJobRepository.save(job);
          this.logger.log(`Updated job ${jobId} status to FAILED (still in queue for retry)`);
        }
      } catch (updateError) {
        this.logger.error(`Failed to update job ${jobId} status after submission error`, updateError);
      }

      throw error;
    }
  }

  /**
   * Best-effort removal of temp files left on the printer by previous
   * File-Storage prints. Never throws — a failure here must not block the new
   * print; the path stays pending and is retried before the next print.
   */
  private async cleanupPendingTempFiles(printerApi: { deleteFile(path: string): Promise<void> }, printerId: number) {
    const pending = this.pendingTempFiles.get(printerId);
    if (!pending || pending.size === 0) return;

    for (const path of [...pending]) {
      try {
        await printerApi.deleteFile(path);
        pending.delete(path);
        this.logger.log(`Deleted temp print file ${path} on printer ${printerId}`);
      } catch (e) {
        this.logger.warn(
          `Could not delete temp print file ${path} on printer ${printerId} (will retry next print): ${
            e instanceof Error ? e.message : e
          }`,
        );
      }
    }
  }
}
