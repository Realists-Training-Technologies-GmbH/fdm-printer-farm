import { setupTestApp } from "../test-server";
import { DITokens } from "@/container.tokens";
import { FileStorageService } from "@/services/file-storage.service";
import { expectOkResponse, expectInvalidResponse, expectNotFoundResponse } from "../extensions";
import { AppConstants } from "@/server.constants";
import { ConflictException } from "@/exceptions/runtime.exceptions";
import TestAgent from "supertest/lib/agent";
import { Test } from "supertest";

describe("FileStorageController", () => {
  let testRequest: TestAgent<Test>;
  let fileStorageService: FileStorageService;

  const baseRoute = AppConstants.apiRoute + "/file-storage";
  const SIMPLE_GCODE = "G28\nG1 X10 Y10\n";

  const uploadFile = (filename: string, content: string) => {
    return testRequest
      .post(`${baseRoute}/upload`)
      .set("Accept", "application/json")
      .attach("file", Buffer.from(content), filename);
  };

  const uploadFileTo = (filename: string, content: string, folderPath: string) => {
    return testRequest
      .post(`${baseRoute}/upload`)
      .set("Accept", "application/json")
      .field("folderPath", folderPath)
      .attach("file", Buffer.from(content), filename);
  };

  let mockFileIdCounter = 0;
  let uploadedFilenames: Map<string, string>;
  // Folder-aware uniqueness map: key is `${folderPath ?? ""}|${filename}`.
  let uploadedKeys: Map<string, string>;
  const uniqKey = (filename: string, folderPath?: string | null) => `${folderPath ?? ""}|${filename}`;

  beforeAll(async () => {
    const { request, container } = await setupTestApp(false);
    testRequest = request;
    fileStorageService = container.resolve<FileStorageService>(DITokens.fileStorageService);
    uploadedFilenames = new Map();
    uploadedKeys = new Map();

    vi.spyOn(fileStorageService, "saveFile").mockImplementation(async (file) => {
      const fileId = `mock-file-id-${++mockFileIdCounter}`;
      uploadedFilenames.set(file.originalname, fileId);
      return fileId;
    });

    vi.spyOn(fileStorageService, "calculateFileHash").mockResolvedValue("mock-hash-abc123");
    vi.spyOn(fileStorageService, "getFilePath").mockImplementation((id: string) => `/mock/path/${id}`);
    // Record the (folder, filename) key so the uniqueness mock can scope by folder.
    vi.spyOn(fileStorageService, "saveMetadata").mockImplementation(
      async (fileStorageId, _metadata, _fileHash, originalFileName, _thumbs, folderPath) => {
        if (originalFileName) uploadedKeys.set(uniqKey(originalFileName, folderPath), fileStorageId);
      },
    );
    vi.spyOn(fileStorageService, "saveThumbnails").mockResolvedValue([]);

    vi.spyOn(fileStorageService, "validateUniqueFilename").mockImplementation(
      async (filename: string, folderPath?: string | null) => {
        const existingId = uploadedKeys.get(uniqKey(filename, folderPath));
        if (existingId) {
          const scope =
            folderPath === undefined ? "in storage" : folderPath ? `in folder "${folderPath}"` : "in the root folder";
          throw new ConflictException(
            `A file named "${filename}" already exists ${scope}. Please rename the file, delete the existing file (ID: ${existingId}), or choose a different name.`,
            existingId,
          );
        }
      },
    );

    vi.spyOn(fileStorageService, "findDuplicateByOriginalFileName").mockImplementation(
      async (filename: string, folderPath?: string | null) => {
        const existingId = uploadedKeys.get(uniqKey(filename, folderPath));
        return existingId ? { fileStorageId: existingId, metadata: { _originalFileName: filename } } : null;
      },
    );
  });

  beforeEach(() => {
    // Reset spy call history between tests (implementations from beforeAll are
    // preserved). Without this, per-test spies like deleteFile accumulate calls
    // across tests and cross-contaminate assertions.
    vi.clearAllMocks();
    uploadedFilenames.clear();
    uploadedKeys.clear();
    mockFileIdCounter = 0;
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  describe("GET /api/file-storage - List files", () => {
    beforeEach(() => {
      vi.spyOn(fileStorageService, "listAllFiles").mockResolvedValue([]);
    });

    it("should return empty array when no files exist", async () => {
      const res = await testRequest.get(baseRoute);
      expectOkResponse(res);
      expect(Array.isArray(res.body.files)).toBe(true);
      expect(res.body.files.length).toBe(0);
    });

    it("should return list of files with metadata", async () => {
      vi.spyOn(fileStorageService, "listAllFiles").mockResolvedValue([
        {
          fileStorageId: "file-123",
          fileName: "test.gcode",
          fileFormat: "gcode",
          fileSize: 1024,
          fileHash: "abc123",
          createdAt: new Date(),
          thumbnailCount: 2,
          metadata: { _originalFileName: "test.gcode" },
        },
      ]);

      const res = await testRequest.get(baseRoute);
      expectOkResponse(res);
      expect(res.body.files.length).toBe(1);
      expect(res.body.files[0].fileName).toBe("test.gcode");
      expect(res.body.files[0].fileStorageId).toBe("file-123");
    });
  });

  describe("GET /api/file-storage/:id - Get file info", () => {
    it("should return 404 for non-existent file", async () => {
      vi.spyOn(fileStorageService, "getFileInfo").mockResolvedValue(null);

      const res = await testRequest.get(`${baseRoute}/non-existent-id`);
      expectNotFoundResponse(res);
    });

    it("should return file info for existing file", async () => {
      vi.spyOn(fileStorageService, "getFileInfo").mockResolvedValue({
        fileStorageId: "file-123",
        fileName: "test.gcode",
        fileFormat: "gcode",
        fileSize: 1024,
        fileHash: "abc123",
        createdAt: new Date(),
        thumbnailCount: 1,
        metadata: { _originalFileName: "test.gcode" },
      });

      const res = await testRequest.get(`${baseRoute}/file-123`);
      expectOkResponse(res);
      expect(res.body.fileStorageId).toBe("file-123");
      expect(res.body.fileName).toBe("test.gcode");
    });
  });

  describe("DELETE /api/file-storage/:id - Delete file", () => {
    it("should delete file successfully", async () => {
      vi.spyOn(fileStorageService, "deleteFile").mockResolvedValue(undefined);

      const res = await testRequest.delete(`${baseRoute}/file-123`);
      expectOkResponse(res);
      expect(fileStorageService.deleteFile).toHaveBeenCalledWith("file-123");
    });
  });

  describe("DELETE /api/file-storage/folders - Delete folder", () => {
    it("deleteFiles=true permanently deletes every file in the subtree (rm -rf)", async () => {
      await testRequest.post(`${baseRoute}/folders`).send({ path: "/delA" });
      await testRequest.post(`${baseRoute}/folders`).send({ path: "/delA/sub" });
      vi.spyOn(fileStorageService, "listAllFiles").mockResolvedValue([
        { fileStorageId: "f-1", metadata: { _folderPath: "/delA" } },
        { fileStorageId: "f-2", metadata: { _folderPath: "/delA/sub" } },
        { fileStorageId: "f-root", metadata: { _folderPath: null } },
      ] as any);
      const del = vi.spyOn(fileStorageService, "deleteFile").mockResolvedValue(undefined);
      const move = vi.spyOn(fileStorageService, "setFolderPath").mockResolvedValue(undefined);

      const res = await testRequest.delete(`${baseRoute}/folders?path=/delA&deleteFiles=true&force=true`);
      expectOkResponse(res);
      expect(del).toHaveBeenCalledWith("f-1");
      expect(del).toHaveBeenCalledWith("f-2");
      expect(del).not.toHaveBeenCalledWith("f-root");
      expect(move).not.toHaveBeenCalled();
      expect(res.body.filesDeleted).toBe(2);
    });

    it("cascade=true moves files to root instead of deleting them", async () => {
      await testRequest.post(`${baseRoute}/folders`).send({ path: "/delB" });
      vi.spyOn(fileStorageService, "listAllFiles").mockResolvedValue([
        { fileStorageId: "g-1", metadata: { _folderPath: "/delB" } },
      ] as any);
      const del = vi.spyOn(fileStorageService, "deleteFile").mockResolvedValue(undefined);
      const move = vi.spyOn(fileStorageService, "setFolderPath").mockResolvedValue(undefined);

      const res = await testRequest.delete(`${baseRoute}/folders?path=/delB&cascade=true&force=true`);
      expectOkResponse(res);
      expect(move).toHaveBeenCalledWith("g-1", null);
      expect(del).not.toHaveBeenCalled();
      expect(res.body.filesMovedToRoot).toBe(1);
    });

    it("409 when the folder has files and neither cascade nor deleteFiles is set", async () => {
      await testRequest.post(`${baseRoute}/folders`).send({ path: "/delC" });
      vi.spyOn(fileStorageService, "listAllFiles").mockResolvedValue([
        { fileStorageId: "h-1", metadata: { _folderPath: "/delC" } },
      ] as any);

      const res = await testRequest.delete(`${baseRoute}/folders?path=/delC`);
      expect(res.status).toBe(409);
      expect(res.body.error).toContain("deleteFiles=true");
    });
  });

  describe("POST /api/file-storage/upload - Upload file", () => {
    it("should upload gcode file successfully", async () => {
      const res = await uploadFile("test.gcode", SIMPLE_GCODE);

      expectOkResponse(res);
      expect(res.body.message).toBe("File uploaded successfully");
      expect(res.body.fileStorageId).toBeDefined();
      expect(res.body.fileName).toBe("test.gcode");
      expect(res.body.fileHash).toBeDefined();
    });

    it("should return 400 when no file is uploaded", async () => {
      const res = await testRequest.post(`${baseRoute}/upload`).set("Accept", "application/json");

      expectInvalidResponse(res);
    });

    it("should return 400 when multiple files are uploaded", async () => {
      const res = await testRequest
        .post(`${baseRoute}/upload`)
        .set("Accept", "application/json")
        .attach("file", Buffer.from(SIMPLE_GCODE), "test1.gcode")
        .attach("file", Buffer.from(SIMPLE_GCODE), "test2.gcode");

      expectInvalidResponse(res);
    });

    it("should reject duplicate filename uploads", async () => {
      const filename = "duplicate-storage.gcode";

      const res1 = await uploadFile(filename, SIMPLE_GCODE);
      expectOkResponse(res1);

      const res2 = await uploadFile(filename, "G28\nG1 X20 Y20\n");
      expect(res2.status).toBe(409);
      expect(res2.body.error).toContain("already exists");
      expect(res2.body.error).toContain(filename);
      expect(res2.body.existingResourceId).toBeDefined();
    });

    it("allows the same filename in different folders (per-folder uniqueness)", async () => {
      await testRequest.post(`${baseRoute}/folders`).send({ path: "/dirA" });
      await testRequest.post(`${baseRoute}/folders`).send({ path: "/dirB" });

      const r1 = await uploadFileTo("same-name.gcode", SIMPLE_GCODE, "/dirA");
      expectOkResponse(r1);
      const r2 = await uploadFileTo("same-name.gcode", SIMPLE_GCODE, "/dirB");
      expectOkResponse(r2);
    });

    it("rejects the same filename within the same folder", async () => {
      await testRequest.post(`${baseRoute}/folders`).send({ path: "/dirC" });

      const r1 = await uploadFileTo("dup-in-folder.gcode", SIMPLE_GCODE, "/dirC");
      expectOkResponse(r1);
      const r2 = await uploadFileTo("dup-in-folder.gcode", "G28\nG1 X5 Y5\n", "/dirC");
      expect(r2.status).toBe(409);
      expect(r2.body.error).toContain('folder "/dirC"');
    });

    it("a name used in a subfolder doesn't block the same name at root", async () => {
      await testRequest.post(`${baseRoute}/folders`).send({ path: "/dirD" });

      const r1 = await uploadFileTo("root-vs-folder.gcode", SIMPLE_GCODE, "/dirD");
      expectOkResponse(r1);
      const r2 = await uploadFile("root-vs-folder.gcode", SIMPLE_GCODE);
      expectOkResponse(r2);
    });

    it("should accept .3mf files", async () => {
      const res = await uploadFile("test.3mf", SIMPLE_GCODE);
      expect(res.status).toBeGreaterThanOrEqual(200);
    });

    it("should accept .bgcode files", async () => {
      const res = await uploadFile("test.bgcode", SIMPLE_GCODE);
      expect(res.status).toBeGreaterThanOrEqual(200);
    });

    it("should reject invalid file extensions", async () => {
      const res = await uploadFile("test.txt", "not a gcode file");
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it("should handle files with special characters in name", async () => {
      const specialNames = ["test with spaces.gcode", "test-with-dashes.gcode", "test_with_underscores.gcode"];

      for (const name of specialNames) {
        const res = await uploadFile(name, SIMPLE_GCODE);
        expectOkResponse(res);
        expect(res.body.fileName).toBe(name);
      }
    });

    it("should include metadata in response", async () => {
      const res = await uploadFile("metadata-test.gcode", SIMPLE_GCODE);

      expectOkResponse(res);
      expect(res.body.metadata).toBeDefined();
      expect(res.body.fileHash).toBeDefined();
    });

    it("should include thumbnail count in response", async () => {
      const res = await uploadFile("thumb-test.gcode", SIMPLE_GCODE);

      expectOkResponse(res);
      expect(res.body).toHaveProperty("thumbnailCount");
      expect(typeof res.body.thumbnailCount).toBe("number");
    });
  });

  describe("PATCH /api/file-storage/:id/folder - Move file (per-folder uniqueness)", () => {
    it("409 when moving a file into a folder that already has that name", async () => {
      uploadedKeys.set(uniqKey("clash.gcode", null), "existing-id");
      vi.spyOn(fileStorageService, "fileExists").mockResolvedValue(true);
      vi.spyOn(fileStorageService, "loadMetadata").mockResolvedValue({ _originalFileName: "clash.gcode" });
      const set = vi.spyOn(fileStorageService, "setFolderPath").mockResolvedValue(undefined);

      const res = await testRequest.patch(`${baseRoute}/other-id/folder`).send({ folderPath: null });
      expect(res.status).toBe(409);
      expect(res.body.error).toContain("already exists");
      expect(set).not.toHaveBeenCalled();
    });

    it("allows the move when there's no name clash in the destination", async () => {
      vi.spyOn(fileStorageService, "fileExists").mockResolvedValue(true);
      vi.spyOn(fileStorageService, "loadMetadata").mockResolvedValue({ _originalFileName: "unique.gcode" });
      const set = vi.spyOn(fileStorageService, "setFolderPath").mockResolvedValue(undefined);

      const res = await testRequest.patch(`${baseRoute}/some-id/folder`).send({ folderPath: null });
      expectOkResponse(res);
      expect(set).toHaveBeenCalledWith("some-id", null);
    });

    it("allows re-saving a file into the folder it's already in (no self-clash)", async () => {
      uploadedKeys.set(uniqKey("self.gcode", null), "self-id");
      vi.spyOn(fileStorageService, "fileExists").mockResolvedValue(true);
      vi.spyOn(fileStorageService, "loadMetadata").mockResolvedValue({ _originalFileName: "self.gcode" });
      const set = vi.spyOn(fileStorageService, "setFolderPath").mockResolvedValue(undefined);

      const res = await testRequest.patch(`${baseRoute}/self-id/folder`).send({ folderPath: null });
      expectOkResponse(res);
      expect(set).toHaveBeenCalledWith("self-id", null);
    });
  });

  describe("getDeterministicId - folder-scoped storage ids", () => {
    it("gives the same name+content in different folders distinct ids (no overwrite)", () => {
      const root = fileStorageService.getDeterministicId("hashX", "foo.gcode", null);
      const inFolder = fileStorageService.getDeterministicId("hashX", "foo.gcode", "/Bauteile");
      expect(root).not.toBe(inFolder);
    });

    it("is backward-compatible at root (folderPath null === omitted)", () => {
      const withNull = fileStorageService.getDeterministicId("hashX", "foo.gcode", null);
      const legacy = fileStorageService.getDeterministicId("hashX", "foo.gcode");
      expect(withNull).toBe(legacy);
    });

    it("is stable for the same content+name+folder", () => {
      const a = fileStorageService.getDeterministicId("hashX", "foo.gcode", "/X");
      const b = fileStorageService.getDeterministicId("hashX", "foo.gcode", "/X");
      expect(a).toBe(b);
    });
  });

  describe("GET /api/file-storage/:id/thumbnail/:index - Get thumbnail", () => {
    it("should return 404 for non-existent thumbnail", async () => {
      vi.spyOn(fileStorageService, "getThumbnail").mockResolvedValue(null);

      const res = await testRequest.get(`${baseRoute}/file-123/thumbnail/0`);
      expectNotFoundResponse(res);
    });

    it("should return thumbnail when it exists", async () => {
      const mockImage = Buffer.from("fake image data");
      vi.spyOn(fileStorageService, "getThumbnail").mockResolvedValue(mockImage);

      const res = await testRequest.get(`${baseRoute}/file-123/thumbnail/0`);
      expectOkResponse(res);
    });
  });

  describe("Edge cases", () => {
    it("should handle very long filenames", async () => {
      const longFilename = "a".repeat(200) + ".gcode";
      const res = await uploadFile(longFilename, SIMPLE_GCODE);
      expectOkResponse(res);
    });

    it("should handle empty gcode file", async () => {
      const res = await uploadFile("empty.gcode", "");
      expectOkResponse(res);
    });

    it("should handle large file content", async () => {
      const largeContent = "G28\n" + "G1 X10 Y10\n".repeat(10000);
      const res = await uploadFile("large.gcode", largeContent);
      expectOkResponse(res);
    });
  });

  describe("Concurrent operations", () => {
    it("should handle multiple concurrent uploads", async () => {
      const uploads = Array.from({ length: 3 }, (_, i) =>
        uploadFile(`concurrent-${i}.gcode`, `G28\nG1 X${i * 10} Y${i * 10}\n`),
      );

      const results = await Promise.all(uploads);

      results.forEach((res) => {
        expectOkResponse(res);
      });

      const fileIds = results.map((r) => r.body.fileStorageId);
      const uniqueIds = new Set(fileIds);
      expect(uniqueIds.size).toBe(3);
    });
  });
});
