import { setupTestApp } from "../test-server";
import { createTestPrinter } from "../api/test-data/create-printer";
import { DITokens } from "@/container.tokens";
import { PrintQueueService, PRINTER_TEMP_FOLDER } from "@/services/print-queue.service";
import { AppConstants } from "@/server.constants";
import { asValue } from "awilix";
import { Readable } from "node:stream";

// The queue uploads File-Storage prints into a temp subfolder on the printer
// and deletes the previous print's temp file right before the next upload
// (delete-on-completion is unreliable on PrusaLink — see the service comment).
describe("PrintQueueService — printer temp folder for prints", () => {
  let printQueueService: PrintQueueService;
  let mockPrinterApi: { uploadFile: any; createFolder: any; deleteFile: any };
  let printerId: number;

  // handleJobSubmission is event-driven and private; invoke it directly so the
  // upload/cleanup behaviour is deterministic to assert.
  const submit = (jobId: number, fileName: string, fileStorageId: string | null) =>
    (printQueueService as any).handleJobSubmission(printerId, jobId, fileName, fileStorageId, null);

  beforeAll(async () => {
    mockPrinterApi = {
      uploadFile: vi.fn().mockResolvedValue(undefined),
      createFolder: vi.fn().mockResolvedValue(undefined),
      deleteFile: vi.fn().mockResolvedValue(undefined),
    };
    const mockPrinterApiFactory = { getById: vi.fn().mockReturnValue(mockPrinterApi) };
    const mockFileStorageService = {
      ensureStorageDirectories: vi.fn().mockResolvedValue(undefined),
      getFileSize: vi.fn().mockReturnValue(1024),
      readFileStream: vi.fn().mockReturnValue(Readable.from([Buffer.from("; gcode\nG28\n")])),
    };

    const { request, container } = await setupTestApp(
      false,
      {
        [DITokens.printerApiFactory]: asValue(mockPrinterApiFactory),
        [DITokens.fileStorageService]: asValue(mockFileStorageService),
      },
      true,
      false,
    );
    printQueueService = container.resolve<PrintQueueService>(DITokens.printQueueService);
    const printer = await createTestPrinter(request);
    printerId = printer.id;
  });

  beforeEach(() => vi.clearAllMocks());

  it("uploads into the temp folder (and pre-creates it), no delete on the first print", async () => {
    await submit(1, "first.gcode", "fs-1");

    expect(mockPrinterApi.createFolder).toHaveBeenCalledWith(PRINTER_TEMP_FOLDER);
    expect(mockPrinterApi.uploadFile).toHaveBeenCalledTimes(1);
    const arg = mockPrinterApi.uploadFile.mock.calls[0][0];
    expect(arg.targetPath).toBe(PRINTER_TEMP_FOLDER);
    expect(arg.fileName).toBe("first.gcode");
    expect(arg.startPrint).toBe(true);
    expect(mockPrinterApi.deleteFile).not.toHaveBeenCalled();
  });

  it("deletes the previous print's temp file before uploading the next", async () => {
    await submit(2, "second.gcode", "fs-2");

    expect(mockPrinterApi.deleteFile).toHaveBeenCalledWith(`${PRINTER_TEMP_FOLDER}/first.gcode`);
    // delete happens before the new upload
    const delOrder = mockPrinterApi.deleteFile.mock.invocationCallOrder[0];
    const upOrder = mockPrinterApi.uploadFile.mock.invocationCallOrder[0];
    expect(delOrder).toBeLessThan(upOrder);
    expect(mockPrinterApi.uploadFile.mock.calls[0][0].fileName).toBe("second.gcode");
  });

  it("a failed delete doesn't block the print and is retried next time", async () => {
    mockPrinterApi.deleteFile.mockRejectedValueOnce(new Error("409 in use"));

    // third print: delete of second.gcode fails, but upload still happens
    await expect(submit(3, "third.gcode", "fs-3")).resolves.not.toThrow();
    expect(mockPrinterApi.deleteFile).toHaveBeenCalledWith(`${PRINTER_TEMP_FOLDER}/second.gcode`);
    expect(mockPrinterApi.uploadFile).toHaveBeenCalledTimes(1);

    // fourth print: the still-pending second.gcode is retried (and third.gcode too is now pending)
    await submit(4, "fourth.gcode", "fs-4");
    expect(mockPrinterApi.deleteFile).toHaveBeenCalledWith(`${PRINTER_TEMP_FOLDER}/second.gcode`);
  });
});
