import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { AppConstants } from "@/server.constants";
import { FileStorageService } from "@/services/file-storage.service";

// Filesystem-maturity tests for the server File Storage, run against an
// isolated temp media dir (no DB, no pollution of ./media). They exercise the
// disk-level logic where content can be lost: storage-id derivation, saving,
// metadata folder membership, duplicate detection, and listing.

const loggerStub = { log() {}, info() {}, debug() {}, warn() {}, error() {}, newDebug() {} };
const loggerFactory = () => loggerStub as any;
// FileStorageService only touches the DB for findDuplicateByHash (unused here),
// so a stub data source is enough.
const typeormStub = { getDataSource: () => ({ getRepository: () => ({}) }) } as any;

const hashOf = (content: string) => createHash("sha256").update(content).digest("hex");

describe("File Storage — folder filesystem semantics", () => {
  let svc: FileStorageService;
  let tmp: string;
  let prevMediaPath: string | undefined;

  beforeAll(async () => {
    prevMediaPath = process.env[AppConstants.MEDIA_PATH];
    tmp = await mkdtemp(join(tmpdir(), "fdmm-fs-"));
    process.env[AppConstants.MEDIA_PATH] = tmp;
    svc = new FileStorageService(loggerFactory, typeormStub);
    await svc.ensureStorageDirectories();
  });

  afterAll(async () => {
    if (prevMediaPath === undefined) delete process.env[AppConstants.MEDIA_PATH];
    else process.env[AppConstants.MEDIA_PATH] = prevMediaPath;
    await rm(tmp, { recursive: true, force: true });
  });

  // Mimic the controller's upload sequence (minus analysis): hash → saveFile → saveMetadata.
  async function put(name: string, content: string, folderPath: string | null) {
    const hash = hashOf(content);
    const file = { originalname: name, buffer: Buffer.from(content) } as any;
    const id = await svc.saveFile(file, hash, folderPath);
    await svc.saveMetadata(id, {}, hash, name, [], folderPath);
    return id;
  }

  async function listIn(folderPath: string | null) {
    const all = await svc.listAllFiles();
    return all.filter((f) => (f.metadata?._folderPath ?? null) === folderPath);
  }

  it("keeps the same name+content in different folders as separate files (no overwrite)", async () => {
    const rootId = await put("part.gcode", "G28\nG1 X1\n", null);
    const subId = await put("part.gcode", "G28\nG1 X1\n", "/Bauteile/Schrauben");

    expect(rootId).not.toBe(subId);
    expect((await listIn(null)).some((f) => f.fileStorageId === rootId)).toBe(true);
    expect((await listIn("/Bauteile/Schrauben")).some((f) => f.fileStorageId === subId)).toBe(true);
  });

  it("re-uploading the same nested folder doesn't lose sibling files (different names coexist)", async () => {
    await put("a.gcode", "AAAA\n", "/Lib/sub");
    await put("b.gcode", "BBBB\n", "/Lib/sub");

    const files = await listIn("/Lib/sub");
    const names = files.map((f) => f.metadata?._originalFileName).sort();
    expect(names).toEqual(["a.gcode", "b.gcode"]);
  });

  it("identical name+content+folder is idempotent (same id, single entry)", async () => {
    const id1 = await put("dup.gcode", "SAME\n", "/X");
    const id2 = await put("dup.gcode", "SAME\n", "/X");
    expect(id2).toBe(id1);
    expect(await listIn("/X")).toHaveLength(1);
  });

  it("findDuplicateByOriginalFileName is folder-scoped", async () => {
    await put("scoped.gcode", "Z\n", "/folderA");
    expect(await svc.findDuplicateByOriginalFileName("scoped.gcode", "/folderA")).not.toBeNull();
    expect(await svc.findDuplicateByOriginalFileName("scoped.gcode", "/folderB")).toBeNull();
    expect(await svc.findDuplicateByOriginalFileName("scoped.gcode", null)).toBeNull();
  });

  it("same name in deep parallel subtrees stays independent", async () => {
    const id1 = await put("m3.gcode", "C1\n", "/Proj/A/Schrauben");
    const id2 = await put("m3.gcode", "C1\n", "/Proj/B/Schrauben");
    expect(id1).not.toBe(id2);
    expect(await listIn("/Proj/A/Schrauben")).toHaveLength(1);
    expect(await listIn("/Proj/B/Schrauben")).toHaveLength(1);
  });

  it("renaming a folder then re-uploading the original keeps the renamed folder's nested files", async () => {
    // Repro of the reported data loss: upload "Bauteile", rename it, re-upload "Bauteile".
    // The moved file keeps its old folder-derived id, so a naive re-upload to the
    // original path recomputes that id and would clobber the moved file's metadata.
    const origId = await put("teil.gcode", "BAUTEIL\n", "/RenameRepro/sub");

    // Folder rename re-parents the file's metadata (controller calls this on rename).
    expect(await svc.moveFilesToFolder("/RenameRepro", "/RenameReproRenamed")).toBe(1);
    expect(await listIn("/RenameReproRenamed/sub")).toHaveLength(1);

    // Re-upload the very same file to the original path.
    const reuploadId = await put("teil.gcode", "BAUTEIL\n", "/RenameRepro/sub");

    // Both must coexist — the renamed folder must NOT lose its file.
    expect(reuploadId).not.toBe(origId);
    expect(await listIn("/RenameReproRenamed/sub")).toHaveLength(1);
    expect(await listIn("/RenameRepro/sub")).toHaveLength(1);
  });
});
