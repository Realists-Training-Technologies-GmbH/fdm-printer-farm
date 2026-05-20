import { IsNull, Repository } from "typeorm";
import { FileStorageFolder } from "@/entities/file-storage-folder.entity";
import type { ILoggerFactory } from "@/handlers/logger-factory";
import { TypeormService } from "@/services/typeorm/typeorm.service";
import { BadRequestException, ConflictException, NotFoundException } from "@/exceptions/runtime.exceptions";

export interface FileStorageFolderDto {
  id: number;
  path: string;
  parentPath: string | null;
  name: string;
  createdAt: Date;
}

const MAX_DEPTH = 32;
const MAX_NAME_LENGTH = 100;
const FORBIDDEN_NAME_CHARS = /[\\/:*?"<>|]/;

export class FileStorageFolderService {
  private readonly logger;
  private readonly repository: Repository<FileStorageFolder>;

  constructor(loggerFactory: ILoggerFactory, typeormService: TypeormService) {
    this.logger = loggerFactory(FileStorageFolderService.name);
    this.repository = typeormService.getDataSource().getRepository(FileStorageFolder);
  }

  /**
   * Normalise a user-supplied path to the canonical form we store:
   *  - leading slash, no trailing slash, no double slashes
   *  - root is `null` (which we externally render as "/")
   *  - throws BadRequest on forbidden characters or empty segments
   */
  static normalisePath(input: string | null | undefined): string | null {
    if (input == null) return null;
    const trimmed = String(input).trim();
    if (trimmed === "" || trimmed === "/") return null;

    const segments = trimmed.split("/").filter(Boolean);
    if (segments.length === 0) return null;
    if (segments.length > MAX_DEPTH) {
      throw new BadRequestException(`Folder path cannot exceed ${MAX_DEPTH} levels deep`);
    }

    for (const segment of segments) {
      if (segment.length > MAX_NAME_LENGTH) {
        throw new BadRequestException(`Folder name "${segment}" exceeds ${MAX_NAME_LENGTH} characters`);
      }
      if (segment === "." || segment === "..") {
        throw new BadRequestException("Folder names cannot be '.' or '..'");
      }
      if (FORBIDDEN_NAME_CHARS.test(segment)) {
        throw new BadRequestException(`Folder name "${segment}" contains forbidden characters`);
      }
    }

    return "/" + segments.join("/");
  }

  static parentOf(path: string | null): string | null {
    if (!path) return null;
    const lastSlash = path.lastIndexOf("/");
    if (lastSlash <= 0) return null;
    return path.substring(0, lastSlash);
  }

  static nameOf(path: string | null): string {
    if (!path) return "";
    return path.substring(path.lastIndexOf("/") + 1);
  }

  /**
   * Return every folder under (and including) the given parent. Pass `null` to
   * get all root-level folders.
   */
  async listChildren(parentPath: string | null): Promise<FileStorageFolderDto[]> {
    const where = parentPath === null ? { parentPath: IsNull() } : { parentPath };
    const rows = await this.repository.find({ where, order: { name: "ASC" } });
    return rows.map(toDto);
  }

  async findByPath(path: string | null): Promise<FileStorageFolder | null> {
    if (path === null) return null;
    return this.repository.findOne({ where: { path } });
  }

  async exists(path: string | null): Promise<boolean> {
    if (path === null) return true; // root always exists
    return (await this.findByPath(path)) !== null;
  }

  /**
   * Create `path` and any missing ancestors. Idempotent — returns the row even
   * if the folder already existed.
   */
  async createFolder(rawPath: string): Promise<FileStorageFolderDto> {
    const normalised = FileStorageFolderService.normalisePath(rawPath);
    if (!normalised) {
      throw new BadRequestException("Cannot create the root folder");
    }

    // Walk ancestors top-down and insert each missing level so empty
    // intermediate folders don't get skipped.
    const segments = normalised.split("/").filter(Boolean);
    let runningPath = "";
    let lastRow: FileStorageFolder | null = null;
    for (let i = 0; i < segments.length; i++) {
      runningPath += "/" + segments[i];
      const parent = i === 0 ? null : runningPath.substring(0, runningPath.lastIndexOf("/"));
      let row = await this.repository.findOne({ where: { path: runningPath } });
      if (!row) {
        row = this.repository.create({
          path: runningPath,
          parentPath: parent,
          name: segments[i],
        });
        try {
          row = await this.repository.save(row);
          this.logger.log(`Created folder ${runningPath}`);
        } catch (e) {
          // Race-condition guard: another concurrent request created it.
          row = await this.repository.findOne({ where: { path: runningPath } });
          if (!row) throw e;
        }
      }
      lastRow = row;
    }

    if (!lastRow) {
      throw new BadRequestException("Failed to create folder");
    }
    return toDto(lastRow);
  }

  /**
   * Rename / move a folder. `newPath` may live under a completely different
   * parent; we update every descendant's `path` and `parentPath` so the
   * subtree moves as a unit.
   */
  async renameFolder(oldRawPath: string, newRawPath: string): Promise<FileStorageFolderDto> {
    const oldPath = FileStorageFolderService.normalisePath(oldRawPath);
    const newPath = FileStorageFolderService.normalisePath(newRawPath);
    if (!oldPath || !newPath) {
      throw new BadRequestException("Both source and destination paths are required");
    }
    if (oldPath === newPath) {
      const existing = await this.findByPath(oldPath);
      if (!existing) throw new NotFoundException(`Folder ${oldPath} not found`);
      return toDto(existing);
    }
    if (newPath.startsWith(oldPath + "/")) {
      throw new BadRequestException("Cannot move a folder into one of its own descendants");
    }

    const existing = await this.findByPath(oldPath);
    if (!existing) {
      throw new NotFoundException(`Folder ${oldPath} not found`);
    }
    if (await this.findByPath(newPath)) {
      throw new ConflictException(`A folder already exists at ${newPath}`);
    }

    // Ensure the new parent exists (creating ancestors as a side effect of
    // calling createFolder on the parent if it's not root).
    const newParent = FileStorageFolderService.parentOf(newPath);
    if (newParent && !(await this.findByPath(newParent))) {
      await this.createFolder(newParent);
    }

    const descendants = await this.repository
      .createQueryBuilder("f")
      .where("f.path = :oldPath OR f.path LIKE :prefix", {
        oldPath,
        prefix: `${oldPath}/%`,
      })
      .getMany();

    for (const row of descendants) {
      const suffix = row.path.substring(oldPath.length);
      row.path = newPath + suffix;
      row.parentPath = FileStorageFolderService.parentOf(row.path);
      row.name = FileStorageFolderService.nameOf(row.path);
    }
    await this.repository.save(descendants);
    this.logger.log(`Renamed folder ${oldPath} → ${newPath} (${descendants.length} rows)`);

    const moved = await this.findByPath(newPath);
    if (!moved) throw new NotFoundException("Folder vanished after rename");
    return toDto(moved);
  }

  /**
   * Delete a folder. Refuses to delete a folder that still has subfolders
   * (callers must pass `force: true` to recursively delete the subtree).
   * File-side cleanup is the controller's job — this only manages folder rows.
   */
  async deleteFolder(rawPath: string, options: { force?: boolean } = {}): Promise<{ deletedPaths: string[] }> {
    const path = FileStorageFolderService.normalisePath(rawPath);
    if (!path) {
      throw new BadRequestException("Cannot delete the root folder");
    }
    const existing = await this.findByPath(path);
    if (!existing) {
      throw new NotFoundException(`Folder ${path} not found`);
    }

    const subtree = await this.repository
      .createQueryBuilder("f")
      .where("f.path = :path OR f.path LIKE :prefix", { path, prefix: `${path}/%` })
      .getMany();

    if (!options.force && subtree.length > 1) {
      throw new ConflictException(
        `Folder ${path} still contains ${subtree.length - 1} subfolder(s). Pass force=true to delete the whole subtree.`,
      );
    }

    const deletedPaths = subtree.map((row) => row.path);
    await this.repository.remove(subtree);
    this.logger.log(`Deleted ${deletedPaths.length} folder(s) under ${path}`);
    return { deletedPaths };
  }

  /** Return every folder in the tree. Useful for migrations / debug. */
  async listAll(): Promise<FileStorageFolderDto[]> {
    const rows = await this.repository.find({ order: { path: "ASC" } });
    return rows.map(toDto);
  }
}

function toDto(row: FileStorageFolder): FileStorageFolderDto {
  return {
    id: row.id,
    path: row.path,
    parentPath: row.parentPath,
    name: row.name,
    createdAt: row.createdAt,
  };
}
