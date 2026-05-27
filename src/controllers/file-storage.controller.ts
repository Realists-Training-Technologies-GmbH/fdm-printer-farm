import { before, DELETE, GET, PATCH, POST, route } from "awilix-express";
import { AppConstants } from "@/server.constants";
import type { Request, Response } from "express";
import { authorizeRoles, authenticate } from "@/middleware/authenticate";
import { ROLES } from "@/constants/authorization.constants";
import { FileStorageService } from "@/services/file-storage.service";
import { FileStorageFolderService } from "@/services/file-storage-folder.service";
import { MulterService } from "@/services/core/multer.service";
import type { ILoggerFactory } from "@/handlers/logger-factory";
import { LoggerService } from "@/handlers/logger";
import { FileAnalysisService } from "@/services/file-analysis.service";
import { BadRequestException, ConflictException } from "@/exceptions/runtime.exceptions";
import { copyFileSync, existsSync, unlinkSync } from "node:fs";
import { extname } from "node:path";
import AdmZip from "adm-zip";

@route(AppConstants.apiRoute + "/file-storage")
@before([authenticate(), authorizeRoles([ROLES.ADMIN, ROLES.OPERATOR])])
export class FileStorageController {
  private readonly logger: LoggerService;

  constructor(
    loggerFactory: ILoggerFactory,
    private readonly fileStorageService: FileStorageService,
    private readonly fileStorageFolderService: FileStorageFolderService,
    private readonly multerService: MulterService,
    private readonly fileAnalysisService: FileAnalysisService,
  ) {
    this.logger = loggerFactory(FileStorageController.name);
  }

  @GET()
  async listFiles(req: Request, res: Response) {
    try {
      // `folderPath` is the absolute slash-path the client is browsing.
      // Omitted / `/` = root. `recursive=true` returns the full subtree, useful
      // for search UIs.
      const requestedFolder = FileStorageFolderService.normalisePath((req.query.folderPath as string) ?? null);
      const recursive = (req.query.recursive as string) === "true";

      const all = await this.fileStorageService.listAllFiles();
      const filtered = all.filter((file) => {
        const fp: string | null = file.metadata?._folderPath ?? null;
        if (recursive) {
          if (requestedFolder === null) return true;
          return fp === requestedFolder || (fp ?? "").startsWith(requestedFolder + "/");
        }
        // Non-recursive: only direct children of `requestedFolder`.
        return (fp ?? null) === requestedFolder;
      });

      const folders = await this.fileStorageFolderService.listChildren(requestedFolder);

      res.send({
        folderPath: requestedFolder ?? "/",
        folders: folders.map((f) => ({
          path: f.path,
          name: f.name,
          createdAt: f.createdAt,
        })),
        files: filtered.map((file) => {
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
            fileFormat: file.fileFormat,
            fileSize: file.fileSize,
            fileHash: file.fileHash,
            createdAt: file.createdAt,
            folderPath: file.metadata?._folderPath ?? null,
            thumbnails,
            metadata: file.metadata,
          };
        }),
        totalCount: filtered.length,
      });
    } catch (error) {
      this.logger.error(`Failed to list files: ${error}`);
      res.status(500).send({ error: "Failed to list files" });
    }
  }

  /**
   * Whole folder tree at once — handy for sidebar/tree views that need to
   * render every node without paginating through `?folderPath`.
   */
  @GET()
  @route("/folders/tree")
  async getFolderTree(_req: Request, res: Response) {
    const folders = await this.fileStorageFolderService.listAll();
    res.send({ folders });
  }

  @GET()
  @route("/folders/export")
  async exportFolder(req: Request, res: Response) {
    const folderPath = FileStorageFolderService.normalisePath((req.query.path as string) ?? null);
    if (!folderPath) {
      throw new BadRequestException("`path` query param is required and cannot be root");
    }

    // Everything in the subtree (the folder itself or any descendant).
    const all = await this.fileStorageService.listAllFiles();
    const inside = all.filter((f) => {
      const fp: string | null = f.metadata?._folderPath ?? null;
      if (!fp) return false;
      return fp === folderPath || fp.startsWith(folderPath + "/");
    });

    // Rebuild the folder hierarchy inside the archive using each file's original
    // name, placed under its path relative to the exported folder.
    const zip = new AdmZip();
    for (const f of inside) {
      const buffer = await this.fileStorageService.getFile(f.fileStorageId);
      const fp = f.metadata?._folderPath ?? folderPath;
      const relDir = fp === folderPath ? "" : fp.substring(folderPath.length + 1);
      const name = f.metadata?._originalFileName || f.fileName;
      const entryPath = relDir ? `${relDir}/${name}` : name;
      zip.addFile(entryPath, buffer);
    }

    const folderName = FileStorageFolderService.nameOf(folderPath) || "folder";
    const archive = zip.toBuffer();
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${folderName}.zip"`);
    res.setHeader("Content-Length", archive.length.toString());
    res.send(archive);
  }

  @POST()
  @route("/folders")
  async createFolder(req: Request, res: Response) {
    const body = req.body as { path?: unknown };
    if (typeof body?.path !== "string" || body.path.trim() === "") {
      throw new BadRequestException("`path` is required (absolute, e.g. /clientes/empresa-x)");
    }
    const created = await this.fileStorageFolderService.createFolder(body.path);
    res.status(201).send(created);
  }

  @PATCH()
  @route("/folders")
  async renameFolder(req: Request, res: Response) {
    const body = req.body as { from?: unknown; to?: unknown };
    if (typeof body?.from !== "string" || typeof body?.to !== "string") {
      throw new BadRequestException("`from` and `to` are required");
    }
    const oldPath = FileStorageFolderService.normalisePath(body.from);
    if (!oldPath) {
      throw new BadRequestException("Cannot rename the root folder");
    }

    const updated = await this.fileStorageFolderService.renameFolder(body.from, body.to);
    // Re-parent files that lived under the old path onto the new one so the
    // folder rename is reflected in the file metadata too.
    const moved = await this.fileStorageService.moveFilesToFolder(oldPath, updated.path);
    res.send({ folder: updated, filesUpdated: moved });
  }

  @DELETE()
  @route("/folders")
  async deleteFolder(req: Request, res: Response) {
    const rawPath = (req.query.path as string) ?? "";
    const force = (req.query.force as string) === "true";
    const cascade = (req.query.cascade as string) === "true";
    // Standard filesystem "rm -rf" semantics: also delete the file binaries
    // inside the subtree (not just move them back to root like `cascade`).
    const deleteFiles = (req.query.deleteFiles as string) === "true";

    const normalised = FileStorageFolderService.normalisePath(rawPath);
    if (!normalised) {
      throw new BadRequestException("`path` query param is required and cannot be root");
    }

    // Files anywhere in the subtree (the folder itself or any descendant).
    const all = await this.fileStorageService.listAllFiles();
    const filesInside = all.filter((f) => {
      const fp: string | null = f.metadata?._folderPath ?? null;
      if (!fp) return false;
      return fp === normalised || fp.startsWith(normalised + "/");
    });

    let filesDeleted = 0;
    let filesMovedToRoot = 0;
    if (filesInside.length > 0) {
      if (deleteFiles) {
        // Permanently delete the contained files (binaries + metadata).
        for (const f of filesInside) {
          await this.fileStorageService.deleteFile(f.fileStorageId);
        }
        filesDeleted = filesInside.length;
      } else if (cascade) {
        // Preserve binaries: move them back to root before dropping the folders.
        for (const f of filesInside) {
          await this.fileStorageService.setFolderPath(f.fileStorageId, null);
        }
        filesMovedToRoot = filesInside.length;
      } else {
        res.status(409).send({
          error: `Folder ${normalised} still contains ${filesInside.length} file(s). Pass deleteFiles=true to delete them, or cascade=true to move them back to root.`,
          filesInside: filesInside.length,
        });
        return;
      }
    }

    const result = await this.fileStorageFolderService.deleteFolder(rawPath, { force });
    res.send({ deletedPaths: result.deletedPaths, filesMovedToRoot, filesDeleted });
  }

  @PATCH()
  @route("/:fileStorageId/folder")
  async moveFile(req: Request, res: Response) {
    const { fileStorageId } = req.params as { fileStorageId: string };
    const body = req.body as { folderPath?: unknown };

    const exists = await this.fileStorageService.fileExists(fileStorageId);
    if (!exists) {
      res.status(404).send({ error: "File not found" });
      return;
    }

    // `null` / empty / "/" means move back to root. Any other value must
    // refer to an existing folder.
    const raw = typeof body?.folderPath === "string" ? body.folderPath : null;
    const normalised = FileStorageFolderService.normalisePath(raw);
    if (normalised !== null) {
      const folder = await this.fileStorageFolderService.findByPath(normalised);
      if (!folder) {
        throw new BadRequestException(`Folder ${normalised} doesn't exist — create it first`);
      }
    }

    // Reject a move that would put two files of the same name in one folder —
    // keeps per-folder uniqueness consistent with the upload path.
    const meta = await this.fileStorageService.loadMetadata(fileStorageId);
    const originalName: string | undefined = meta?._originalFileName;
    if (originalName) {
      const clash = await this.fileStorageService.findDuplicateByOriginalFileName(originalName, normalised);
      if (clash && clash.fileStorageId !== fileStorageId) {
        throw new ConflictException(
          `A file named "${originalName}" already exists ${normalised ? `in folder "${normalised}"` : "in the root folder"}. Rename or remove it first.`,
          clash.fileStorageId,
        );
      }
    }

    await this.fileStorageService.setFolderPath(fileStorageId, normalised);
    res.send({ fileStorageId, folderPath: normalised });
  }

  /**
   * Get file metadata
   * GET /api/file-storage/:fileStorageId
   */
  @GET()
  @route("/:fileStorageId")
  async getFileMetadata(req: Request, res: Response) {
    const { fileStorageId } = req.params as { fileStorageId: string };

    try {
      const file = await this.fileStorageService.getFileInfo(fileStorageId);

      if (!file) {
        res.status(404).send({ error: "File not found" });
        return;
      }

      const thumbnails = (file.metadata?._thumbnails || []).map((thumb: any) => ({
        index: thumb.index,
        width: thumb.width,
        height: thumb.height,
        format: thumb.format,
        size: thumb.size,
      }));

      res.send({
        fileStorageId: file.fileStorageId,
        fileName: file.fileName,
        fileFormat: file.fileFormat,
        fileSize: file.fileSize,
        fileHash: file.fileHash,
        createdAt: file.createdAt,
        thumbnails,
        metadata: file.metadata,
      });
    } catch (error) {
      this.logger.error(`Failed to get file metadata for ${fileStorageId}: ${error}`);
      res.status(500).send({ error: "Failed to get file metadata" });
    }
  }

  /**
   * Delete a stored file and its thumbnails
   * DELETE /api/file-storage/:fileStorageId
   */
  @DELETE()
  @route("/:fileStorageId")
  async deleteFile(req: Request, res: Response) {
    const { fileStorageId } = req.params as { fileStorageId: string };

    try {
      await this.fileStorageService.deleteFile(fileStorageId);

      this.logger.log(`Deleted file ${fileStorageId}`);
      res.send({ message: "File deleted successfully", fileStorageId });
    } catch (error) {
      this.logger.error(`Failed to delete file ${fileStorageId}: ${error}`);
      res.status(500).send({ error: "Failed to delete file" });
    }
  }

  @POST()
  @route("/:fileStorageId/analyze")
  async analyzeFile(req: Request, res: Response) {
    const { fileStorageId } = req.params as { fileStorageId: string };

    try {
      const filePath = this.fileStorageService.getFilePath(fileStorageId);
      const fileExists = await this.fileStorageService.fileExists(fileStorageId);
      if (!fileExists) {
        res.status(404).send({ error: "File not found" });
        return;
      }
      this.logger.log(`Analyzing file: ${fileStorageId}`);

      // Load existing metadata to preserve original filename
      const existingMetadata = await this.fileStorageService.loadMetadata(fileStorageId);

      const analysisResult = await this.fileAnalysisService.analyzeFile(filePath);
      const metadata = analysisResult.metadata;
      const thumbnails = analysisResult.thumbnails;

      this.logger.log(
        `Analysis complete for ${fileStorageId}: format=${metadata.fileFormat}, layers=${metadata.totalLayers}, time=${metadata.gcodePrintTimeSeconds}s, thumbnails=${thumbnails.length}`,
      );

      const fileHash = await this.fileStorageService.calculateFileHash(filePath);
      const originalFileName = existingMetadata?._originalFileName || fileStorageId;

      metadata.fileName = originalFileName;

      let thumbnailMetadata: any[] = [];
      if (thumbnails.length > 0) {
        thumbnailMetadata = await this.fileStorageService.saveThumbnails(fileStorageId, thumbnails);
        this.logger.log(`Saved ${thumbnailMetadata.length} thumbnails for ${fileStorageId}`);
      }

      await this.fileStorageService.saveMetadata(
        fileStorageId,
        metadata,
        fileHash,
        originalFileName,
        thumbnailMetadata,
      );

      res.send({
        message: "File analyzed successfully",
        fileStorageId,
        metadata,
        thumbnailCount: thumbnails.length,
      });
    } catch (error) {
      this.logger.error(`Failed to analyze file ${fileStorageId}: ${error}`);
      res.status(500).send({ error: `Failed to analyze file: ${error}` });
    }
  }

  @GET()
  @route("/:fileStorageId/thumbnail/:index")
  async getThumbnailByIndex(req: Request, res: Response) {
    const { fileStorageId, index } = req.params as { fileStorageId: string; index: string };
    const thumbnailIndex = Number.parseInt(index);

    if (Number.isNaN(thumbnailIndex)) {
      res.status(400).send({ error: "Invalid thumbnail index" });
      return;
    }

    try {
      const thumbnail = await this.fileStorageService.getThumbnail(fileStorageId, thumbnailIndex);

      if (!thumbnail) {
        res.status(404).send({ error: "Thumbnail not found" });
        return;
      }

      // Determine content type from magic bytes
      const isJPG = thumbnail[0] === 0xff && thumbnail[1] === 0xd8;
      const isQOI = thumbnail[0] === 0x71 && thumbnail[1] === 0x6f && thumbnail[2] === 0x69 && thumbnail[3] === 0x66;

      // QOI format not supported by browser
      if (isQOI) {
        res.status(404).send({ error: "Thumbnail format not supported (QOI)" });
        return;
      }

      const mimeType = isJPG ? "image/jpeg" : "image/png";
      const base64 = thumbnail.toString("base64");
      res.send({
        thumbnailBase64: `data:${mimeType};base64,${base64}`,
      });
    } catch (error) {
      this.logger.error(`Failed to get thumbnail ${thumbnailIndex} for ${fileStorageId}: ${error}`);
      res.status(500).send({ error: "Failed to get thumbnail" });
    }
  }

  /**
   * Upload a file to storage and analyze it
   * POST /api/file-storage/upload
   */
  @POST()
  @route("/upload")
  async uploadFile(req: Request, res: Response) {
    const acceptedExtensions = [".gcode", ".3mf", ".bgcode"];
    const files = await this.multerService.multerLoadFileAsync(req, res, acceptedExtensions, true);

    if (!files?.length) {
      throw new BadRequestException("No file uploaded");
    }

    if (files.length > 1) {
      throw new BadRequestException("Only 1 file can be uploaded at a time");
    }

    const file = files[0];

    // Optional folder destination — accepted as form field alongside the file.
    const rawFolderPath = typeof req.body?.folderPath === "string" ? req.body.folderPath : null;
    const folderPath = FileStorageFolderService.normalisePath(rawFolderPath);
    if (folderPath && !(await this.fileStorageFolderService.findByPath(folderPath))) {
      throw new BadRequestException(`Folder ${folderPath} doesn't exist — create it before uploading into it`);
    }

    // Uniqueness is scoped to the destination folder, so the same filename can
    // live in different folders (needed for bulk/folder uploads).
    await this.fileStorageService.validateUniqueFilename(file.originalname, folderPath);

    const ext = extname(file.originalname);
    const tempPathWithExt = file.path + ext;

    try {
      copyFileSync(file.path, tempPathWithExt);

      const fileHash = await this.fileStorageService.calculateFileHash(tempPathWithExt);
      this.logger.log(`Analyzing ${file.originalname}`);
      const analysisResult = await this.fileAnalysisService.analyzeFile(tempPathWithExt);
      const { metadata, thumbnails } = analysisResult;

      const fileStorageId = await this.fileStorageService.saveFile(file, fileHash, folderPath);
      this.logger.log(`Saved ${file.originalname} as ${fileStorageId}`);

      const thumbnailMetadata =
        thumbnails.length > 0 ? await this.fileStorageService.saveThumbnails(fileStorageId, thumbnails) : [];

      await this.fileStorageService.saveMetadata(
        fileStorageId,
        metadata,
        fileHash,
        file.originalname,
        thumbnailMetadata,
        folderPath,
      );

      res.send({
        message: "File uploaded successfully",
        fileStorageId,
        fileName: file.originalname,
        fileSize: file.size,
        fileHash,
        folderPath,
        metadata,
        thumbnailCount: thumbnails.length,
      });
    } finally {
      if (existsSync(tempPathWithExt)) {
        unlinkSync(tempPathWithExt);
      }
    }
  }
}
