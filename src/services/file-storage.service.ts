import { Repository } from "typeorm";
import { PrintJob } from "@/entities/print-job.entity";
import type { ILoggerFactory } from "@/handlers/logger-factory";
import { TypeormService } from "@/services/typeorm/typeorm.service";
import { AppConstants } from "@/server.constants";
import { getMediaPath } from "@/utils/fs.utils";
import path, { basename, extname, join } from "node:path";
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync, createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import { ConflictException } from "@/exceptions/runtime.exceptions";

export interface IFileStorageService {
  saveFile(file: Express.Multer.File, fileHash?: string, folderPath?: string | null): Promise<string>;
  getFile(fileStorageId: string): Promise<Buffer>;
  deleteFile(fileStorageId: string): Promise<void>;
  getFilePath(fileStorageId: string): string;
  getFileSize(fileStorageId: string): number;
  calculateFileHash(filePath: string): Promise<string>;
  validateUniqueFilename(fileName: string, folderPath?: string | null): Promise<void>;
  saveMetadata(
    fileStorageId: string,
    metadata: any,
    fileHash?: string,
    originalFileName?: string,
    thumbnailMetadata?: any[],
    folderPath?: string | null,
  ): Promise<void>;
  setFolderPath(fileStorageId: string, folderPath: string | null): Promise<void>;
  moveFilesToFolder(sourceFolderPath: string, destinationFolderPath: string | null): Promise<number>;
  loadMetadata(fileStorageId: string): Promise<any | null>;
  hasMetadata(fileStorageId: string): Promise<boolean>;
  getDeterministicId(fileHash: string, fileName: string, folderPath?: string | null): string;
  findDuplicateByOriginalFileName(
    originalFileName: string,
    folderPath?: string | null,
  ): Promise<{ fileStorageId: string; metadata: any } | null>;
  saveThumbnails(
    fileStorageId: string,
    thumbnails: Array<{ data?: string; format?: string; width?: number; height?: number }>,
  ): Promise<
    Array<{
      index: number;
      path: string;
      filename: string;
      width: number;
      height: number;
      format: string;
      size: number;
    }>
  >;
  getThumbnail(fileStorageId: string, index: number): Promise<Buffer | null>;
  listThumbnails(fileStorageId: string): Promise<string[]>;
}

export class FileStorageService implements IFileStorageService {
  printJobRepository: Repository<PrintJob>;
  private readonly logger;
  private readonly storageBasePath: string;
  private readonly STORAGE_SUBDIRS = ["gcode", "3mf", "bgcode"] as const;

  constructor(loggerFactory: ILoggerFactory, typeormService: TypeormService) {
    this.printJobRepository = typeormService.getDataSource().getRepository(PrintJob);
    this.logger = loggerFactory(FileStorageService.name);

    this.storageBasePath = join(getMediaPath(), AppConstants.defaultPrintFilesStorage);
  }

  async ensureStorageDirectories() {
    try {
      await mkdir(this.storageBasePath, { recursive: true });
      for (const subdir of this.STORAGE_SUBDIRS) {
        await mkdir(join(this.storageBasePath, subdir), { recursive: true });
      }
    } catch (error) {
      this.logger.error("Failed to create storage directories", error);
    }
  }

  readFileStream(fileStorageId: string): Readable {
    const filePath = this.getFilePath(fileStorageId);
    const stream = createReadStream(filePath);

    stream.on("error", (err) => {
      this.logger.error(`Failed to read file ${fileStorageId}: ${err.message}`, err);
    });

    return stream;
  }

  getFileSize(fileStorageId: string): number {
    const filePath = this.getFilePath(fileStorageId);
    const stats = statSync(filePath);
    return stats.size;
  }

  /**
   * Reject a filename that already exists. When `folderPath` is supplied the
   * check is scoped to that folder (so the same name may live in different
   * folders — required for bulk/folder uploads); omitting it keeps the legacy
   * storage-wide check.
   */
  async validateUniqueFilename(fileName: string, folderPath?: string | null): Promise<void> {
    const existing = await this.findDuplicateByOriginalFileName(fileName, folderPath);
    if (existing) {
      const scope =
        folderPath === undefined ? "in storage" : folderPath ? `in folder "${folderPath}"` : "in the root folder";
      throw new ConflictException(
        `A file named "${fileName}" already exists ${scope}. Please rename the file, delete the existing file (ID: ${existing.fileStorageId}), or choose a different name.`,
        existing.fileStorageId,
      );
    }
  }

  async saveFile(file: Express.Multer.File, fileHash?: string, folderPath?: string | null): Promise<string> {
    const fileExt = extname(file.originalname).toLowerCase();

    let subdir = "gcode";
    if (fileExt === ".3mf" || file.originalname.includes(".gcode.3mf")) {
      subdir = "3mf";
    } else if (fileExt === ".bgcode") {
      subdir = "bgcode";
    }
    const targetDir = join(this.storageBasePath, subdir);

    // Deterministic per (content, name, folder) so the same file in different
    // folders gets distinct storage ids — otherwise a same-name+same-content
    // upload into another folder overwrites the existing one on disk.
    let fileId = fileHash ? this.getDeterministicId(fileHash, file.originalname, folderPath) : crypto.randomUUID();

    // A folder rename rewrites a file's `_folderPath` metadata but keeps its
    // (old-folder-derived) storage id and on-disk name. So re-uploading the
    // original file to its *old* path recomputes that same id — which would
    // clobber the moved file's metadata and lose it. Guard: if this id is
    // already taken by a file that now lives in a different folder, mint a
    // fresh id instead of overwriting it. Read the would-be metadata path
    // directly (O(1)) — loadMetadata would re-scan every storage dir per upload.
    if (fileHash) {
      const existingMeta = await this.readMetadataAtPath(join(targetDir, `${fileId}${fileExt}`) + ".json");
      if (existingMeta && (existingMeta._folderPath ?? null) !== (folderPath ?? null)) {
        fileId = crypto.randomUUID();
      }
    }

    const targetPath = join(targetDir, `${fileId}${fileExt}`);

    if (file.path) {
      await rename(file.path, targetPath);
    } else if (file.buffer) {
      await writeFile(targetPath, file.buffer);
    } else {
      throw new Error("File has no path or buffer");
    }

    this.logger.log(`Saved file ${file.originalname} as ${fileId}`);
    return fileId;
  }

  async getFile(fileStorageId: string): Promise<Buffer> {
    const filePath = await this.findFilePath(fileStorageId);
    if (!filePath) {
      throw new Error(`File ${fileStorageId} not found in storage`);
    }

    return readFile(filePath);
  }

  async deleteFile(fileStorageId: string): Promise<void> {
    const filePath = await this.findFilePath(fileStorageId);
    if (!filePath) {
      this.logger.warn(`File ${fileStorageId} not found, cannot delete`);
      return;
    }

    await unlink(filePath);

    const metadataPath = filePath + ".json";
    try {
      await unlink(metadataPath);
      this.logger.debug(`Deleted metadata JSON for ${fileStorageId}`);
    } catch {}

    const thumbnailDir = filePath.replace(/\.(gcode|3mf|bgcode)$/i, "_thumbnails");
    try {
      await rm(thumbnailDir, { recursive: true, force: true });
      this.logger.debug(`Deleted thumbnails for ${fileStorageId}`);
    } catch {}

    this.logger.log(`Deleted file ${fileStorageId}`);
  }

  getFilePath(fileStorageId: string): string {
    for (const subdir of this.STORAGE_SUBDIRS) {
      for (const ext of [".gcode", ".3mf", ".bgcode", ""]) {
        const fullPath = join(this.storageBasePath, subdir, fileStorageId + ext);
        if (existsSync(fullPath)) {
          return fullPath;
        }
      }
    }

    return join(this.storageBasePath, "gcode", fileStorageId);
  }

  async calculateFileHash(filePath: string): Promise<string> {
    const fileBuffer = await readFile(filePath);
    const hashSum = createHash("sha256");
    hashSum.update(fileBuffer);
    return hashSum.digest("hex");
  }

  getDeterministicId(fileHash: string, fileName: string, folderPath?: string | null): string {
    // Include the folder so the same name+content in *different* folders gets
    // distinct ids and doesn't overwrite each other on disk. Root resolves to
    // "" — identical to the legacy `fileHash + fileName` scheme, so existing
    // root files keep their ids.
    const nameHash = createHash("sha256")
      .update(fileHash + (folderPath ?? "") + fileName)
      .digest("hex")
      .substring(0, 32);
    return `${nameHash.substring(0, 8)}-${nameHash.substring(8, 12)}-${nameHash.substring(12, 16)}-${nameHash.substring(16, 20)}-${nameHash.substring(20, 32)}`;
  }

  private async findFilePath(fileStorageId: string): Promise<string | null> {
    for (const subdir of this.STORAGE_SUBDIRS) {
      const dirPath = join(this.storageBasePath, subdir);
      try {
        const files = await readdir(dirPath);
        const matchingFile = files.find((f) => f.startsWith(fileStorageId));
        if (matchingFile) {
          return join(dirPath, matchingFile);
        }
      } catch {}
    }

    return null;
  }

  async fileExists(fileStorageId: string): Promise<boolean> {
    const filePath = await this.findFilePath(fileStorageId);
    return filePath !== null;
  }

  async findDuplicateByHash(fileHash: string): Promise<PrintJob | null> {
    return this.printJobRepository.findOne({
      where: { fileHash },
      order: { createdAt: "DESC" },
    });
  }

  async findDuplicateByOriginalFileName(
    originalFileName: string,
    folderPath?: string | null,
  ): Promise<{
    fileStorageId: string;
    metadata: any;
  } | null> {
    // When a folderPath is passed (including `null` for root), only a same-name
    // file in *that* folder counts as a duplicate. When it's omitted the check
    // stays storage-wide (legacy behaviour).
    const scopeToFolder = folderPath !== undefined;
    const targetFolder = folderPath ?? null;

    for (const subdir of this.STORAGE_SUBDIRS) {
      const dirPath = join(this.storageBasePath, subdir);
      try {
        const dirFiles = await readdir(dirPath);

        for (const file of dirFiles) {
          if (file.endsWith("_thumbnails") || file.endsWith(".json")) continue;

          const fileId = path.parse(file).name;
          // Read the sibling .json directly; loadMetadata() would re-scan every
          // storage dir per file (findFilePath), making each upload's duplicate
          // check O(N²) over the library.
          const metadata = await this.readMetadataAtPath(join(dirPath, file) + ".json");

          if (metadata?._originalFileName !== originalFileName) continue;
          if (scopeToFolder && (metadata?._folderPath ?? null) !== targetFolder) continue;

          return {
            fileStorageId: fileId,
            metadata,
          };
        }
      } catch (error) {
        this.logger.error(`Error searching for duplicate in ${subdir}`, error);
      }
    }

    return null;
  }

  async saveMetadata(
    fileStorageId: string,
    metadata: any,
    fileHash?: string,
    originalFileName?: string,
    thumbnailMetadata?: any[],
    folderPath?: string | null,
  ): Promise<void> {
    const filePath = await this.findFilePath(fileStorageId);
    if (!filePath) {
      this.logger.warn(`Cannot save metadata - file ${fileStorageId} not found`);
      return;
    }

    const metadataPath = filePath + ".json";

    let existingOriginalFileName = originalFileName;
    let existingThumbnails = thumbnailMetadata;
    // `undefined` from the caller means "leave it alone", `null` means "move
    // back to root". Track the existing folderPath so we keep it when no
    // explicit choice was passed.
    let resolvedFolderPath: string | null | undefined = folderPath;
    try {
      const existingContent = await readFile(metadataPath, "utf8");
      const existing = JSON.parse(existingContent);
      if (existing._originalFileName && !originalFileName) {
        existingOriginalFileName = existing._originalFileName;
      }
      if (existing._thumbnails && !thumbnailMetadata) {
        existingThumbnails = existing._thumbnails;
      }
      if (folderPath === undefined && "_folderPath" in existing) {
        resolvedFolderPath = existing._folderPath ?? null;
      }
    } catch {}

    const metadataWithMeta = {
      ...metadata,
      _fileHash: fileHash || null,
      _analyzedAt: new Date().toISOString(),
      _fileStorageId: fileStorageId,
      _originalFileName: existingOriginalFileName || metadata.fileName || null,
      _thumbnails: existingThumbnails || [],
      _folderPath: resolvedFolderPath ?? null,
    };

    await writeFile(metadataPath, JSON.stringify(metadataWithMeta, null, 2), "utf8");
    const thumbnailMeta = thumbnailMetadata ? ` with ${thumbnailMetadata.length} thumbnail(s)` : "";
    this.logger.debug(`Saved metadata for ${fileStorageId}${thumbnailMeta}`);
  }

  /**
   * Update only the folder assignment for a file, preserving everything else
   * in the metadata JSON. Pass `null` to move the file back to the root.
   */
  async setFolderPath(fileStorageId: string, folderPath: string | null): Promise<void> {
    const existing = (await this.loadMetadata(fileStorageId)) ?? {};
    const cleaned = { ...existing };
    // saveMetadata re-injects the underscored fields so strip them here to
    // avoid duplication after the spread.
    delete cleaned._fileHash;
    delete cleaned._analyzedAt;
    delete cleaned._fileStorageId;
    delete cleaned._originalFileName;
    delete cleaned._thumbnails;
    delete cleaned._folderPath;

    await this.saveMetadata(
      fileStorageId,
      cleaned,
      existing?._fileHash ?? undefined,
      existing?._originalFileName ?? undefined,
      existing?._thumbnails ?? undefined,
      folderPath,
    );
  }

  /**
   * Re-parent every file currently filed under `sourceFolderPath` (or any of
   * its subpaths) onto `destinationFolderPath`. Used by folder rename / move.
   * Returns the number of files updated.
   */
  async moveFilesToFolder(sourceFolderPath: string, destinationFolderPath: string | null): Promise<number> {
    const all = await this.listAllFiles();
    let moved = 0;
    for (const file of all) {
      const fp: string | null = file.metadata?._folderPath ?? null;
      if (!fp) continue;
      if (fp === sourceFolderPath || fp.startsWith(sourceFolderPath + "/")) {
        const suffix = fp.substring(sourceFolderPath.length);
        const newPath = destinationFolderPath ? `${destinationFolderPath}${suffix}` : suffix ? suffix : null;
        await this.setFolderPath(file.fileStorageId, newPath);
        moved += 1;
      }
    }
    if (moved > 0) {
      this.logger.log(`Moved ${moved} file(s) from ${sourceFolderPath} to ${destinationFolderPath ?? "root"}`);
    }
    return moved;
  }

  async loadMetadata(fileStorageId: string): Promise<any | null> {
    const filePath = await this.findFilePath(fileStorageId);
    if (!filePath) {
      return null;
    }

    const metadataPath = filePath + ".json";
    try {
      const content = await readFile(metadataPath, "utf8");
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  async hasMetadata(fileStorageId: string): Promise<boolean> {
    const filePath = await this.findFilePath(fileStorageId);
    if (!filePath) {
      return false;
    }

    const metadataPath = filePath + ".json";
    try {
      await access(metadataPath);
      return true;
    } catch {
      return false;
    }
  }

  async saveThumbnails(
    fileStorageId: string,
    thumbnails: Array<{ data?: string; format?: string; width?: number; height?: number }>,
  ): Promise<
    Array<{
      index: number;
      path: string;
      filename: string;
      width: number;
      height: number;
      format: string;
      size: number;
    }>
  > {
    const savedThumbnails: Array<any> = [];

    if (!thumbnails || thumbnails.length === 0) {
      return savedThumbnails;
    }

    const filePath = await this.findFilePath(fileStorageId);
    if (!filePath) {
      this.logger.warn(`Cannot save thumbnails - file ${fileStorageId} not found`);
      return savedThumbnails;
    }

    const thumbnailDir = filePath.replace(/\.(gcode|3mf|bgcode)$/i, "_thumbnails");

    try {
      await rm(thumbnailDir, { recursive: true, force: true });
      this.logger.debug(`Cleared old thumbnails for ${fileStorageId}`);
    } catch {}

    await mkdir(thumbnailDir, { recursive: true });

    for (let i = 0; i < thumbnails.length; i++) {
      const thumb = thumbnails[i];
      if (!thumb.data) continue;

      const ext = thumb.format?.toLowerCase() || "png";
      const filename = `thumb_${i}.${ext}`;
      const thumbPath = join(thumbnailDir, filename);

      try {
        const buffer = Buffer.from(thumb.data, "base64");
        await writeFile(thumbPath, buffer);

        const relativePath = path.relative(this.storageBasePath, thumbPath);

        savedThumbnails.push({
          index: i,
          path: relativePath,
          filename,
          width: thumb.width || 0,
          height: thumb.height || 0,
          format: ext,
          size: buffer.length,
        });

        this.logger.debug(
          `Saved thumbnail ${i} for ${fileStorageId} (${thumb.width}x${thumb.height}, ${buffer.length} bytes)`,
        );
      } catch (error) {
        this.logger.warn(`Failed to save thumbnail ${i} for ${fileStorageId}: ${error}`);
      }
    }

    return savedThumbnails;
  }

  async getThumbnail(fileStorageId: string, index: number): Promise<Buffer | null> {
    const filePath = await this.findFilePath(fileStorageId);
    if (!filePath) return null;

    const thumbnailDir = filePath.replace(/\.(gcode|3mf|bgcode)$/i, "_thumbnails");

    for (const ext of ["png", "jpg", "jpeg", "qoi"]) {
      const thumbPath = join(thumbnailDir, `thumb_${index}.${ext}`);
      try {
        return await readFile(thumbPath);
      } catch {}
    }

    return null;
  }

  async listThumbnails(fileStorageId: string): Promise<string[]> {
    const filePath = await this.findFilePath(fileStorageId);
    if (!filePath) return [];

    const thumbnailDir = filePath.replace(/\.(gcode|3mf|bgcode)$/i, "_thumbnails");

    try {
      const files = await readdir(thumbnailDir);
      return files.filter((f) => f.startsWith("thumb_")).sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  }

  async listAllFiles(): Promise<
    Array<{
      fileStorageId: string;
      fileName: string;
      fileFormat: string;
      fileSize: number;
      fileHash: string;
      createdAt: Date;
      thumbnailCount: number;
      metadata?: any;
    }>
  > {
    const files: any[] = [];

    for (const subdir of this.STORAGE_SUBDIRS) {
      const dirPath = join(this.storageBasePath, subdir);
      try {
        const dirFiles = await readdir(dirPath);
        const entries = dirFiles.filter((f) => !f.endsWith("_thumbnails") && !f.endsWith(".json"));

        // Build each entry straight from the paths we already have. Calling
        // loadMetadata()/listThumbnails() here would re-run findFilePath() — a
        // readdir() scan of every storage dir per file — making the whole listing
        // O(N²) and slow once the library grows. Reading the sibling .json and
        // _thumbnails dir directly keeps it O(N); the per-file work runs in
        // parallel within each subdir.
        const built = await Promise.all(
          entries.map(async (file) => {
            const fileId = path.parse(file).name;
            const filePath = join(dirPath, file);
            const stats = await stat(filePath);
            const metadata = await this.readMetadataAtPath(filePath + ".json");
            const thumbnailCount = await this.countThumbnailsAtDir(
              filePath.replace(/\.(gcode|3mf|bgcode)$/i, "_thumbnails"),
            );

            return {
              fileStorageId: fileId,
              fileName: metadata?._fileName || file,
              fileFormat: subdir,
              fileSize: stats.size,
              fileHash: metadata?._fileHash || "",
              createdAt: stats.birthtime,
              thumbnailCount,
              metadata,
            };
          }),
        );
        files.push(...built);
      } catch (error) {
        this.logger.error(`Error listing files in ${subdir}`, error);
      }
    }

    return files.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /** Read & parse a metadata JSON at a known path. Null if missing/invalid. */
  private async readMetadataAtPath(metadataPath: string): Promise<any | null> {
    try {
      return JSON.parse(await readFile(metadataPath, "utf8"));
    } catch {
      return null;
    }
  }

  /** Count thumbnail images in a known thumbnails dir. 0 if missing. */
  private async countThumbnailsAtDir(thumbnailDir: string): Promise<number> {
    try {
      const thumbs = await readdir(thumbnailDir);
      return thumbs.filter((f) => f.startsWith("thumb_")).length;
    } catch {
      return 0;
    }
  }

  async getFileInfo(fileStorageId: string): Promise<{
    fileStorageId: string;
    fileName: string;
    fileFormat: string;
    fileSize: number;
    fileHash: string;
    createdAt: Date;
    thumbnailCount: number;
    metadata?: any;
  } | null> {
    const filePath = await this.findFilePath(fileStorageId);
    if (!filePath) return null;

    try {
      const stats = await stat(filePath);
      const metadata = await this.loadMetadata(fileStorageId);
      const thumbnails = await this.listThumbnails(fileStorageId);
      const ext = extname(filePath).substring(1);

      return {
        fileStorageId,
        fileName: metadata?._originalFileName || basename(filePath),
        fileFormat: ext,
        fileSize: stats.size,
        fileHash: metadata?._fileHash || "",
        createdAt: stats.birthtime,
        thumbnailCount: thumbnails.length,
        metadata: metadata,
      };
    } catch (error) {
      this.logger.error(`Error getting file info for ${fileStorageId}`, error);
      return null;
    }
  }
}
