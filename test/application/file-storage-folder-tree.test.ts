import { AwilixContainer } from "awilix";
import { setupTestApp } from "../test-server";
import { DITokens } from "@/container.tokens";
import { FileStorageFolderService } from "@/services/file-storage-folder.service";
import { TypeormService } from "@/services/typeorm/typeorm.service";
import { FileStorageFolder } from "@/entities/file-storage-folder.entity";

// Folder-tree semantics for nested subfolders that share a name — the case the
// `path`-as-unique-key model is meant to support but that nothing exercised
// before. Runs against the real repository (in-memory SQLite) via the DI
// container, so it covers createFolder ancestor-walking, listChildren's
// parentPath filter, rename's subtree LIKE-prefix update, and delete.

describe("FileStorageFolderService — nested folders sharing a name", () => {
  let container: AwilixContainer;
  let service: FileStorageFolderService;

  beforeAll(async () => {
    ({ container } = await setupTestApp(false));
    service = container.resolve<FileStorageFolderService>(DITokens.fileStorageFolderService);
  });

  beforeEach(async () => {
    const repo = container
      .resolve<TypeormService>(DITokens.typeormService)
      .getDataSource()
      .getRepository(FileStorageFolder);
    await repo.clear();
  });

  const paths = (rows: { path: string }[]) => rows.map((r) => r.path).sort();

  it("parallel subtrees with the same leaf name are independent rows", async () => {
    await service.createFolder("/Proj/A/Schrauben");
    await service.createFolder("/Proj/B/Schrauben");

    const a = await service.findByPath("/Proj/A/Schrauben");
    const b = await service.findByPath("/Proj/B/Schrauben");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.id).not.toBe(b!.id);

    expect(paths(await service.listChildren("/Proj/A"))).toEqual(["/Proj/A/Schrauben"]);
    expect(paths(await service.listChildren("/Proj/B"))).toEqual(["/Proj/B/Schrauben"]);
    expect(paths(await service.listChildren("/Proj"))).toEqual(["/Proj/A", "/Proj/B"]);
  });

  it("a subfolder may share its own ancestor's name", async () => {
    await service.createFolder("/Schrauben/Schrauben");

    expect(await service.findByPath("/Schrauben")).not.toBeNull();
    expect(await service.findByPath("/Schrauben/Schrauben")).not.toBeNull();

    // The nested one is a child of the outer one, not a duplicate of root.
    const rootChildren = await service.listChildren(null);
    expect(paths(rootChildren)).toEqual(["/Schrauben"]);
    const inner = await service.listChildren("/Schrauben");
    expect(paths(inner)).toEqual(["/Schrauben/Schrauben"]);
    expect(inner[0].name).toBe("Schrauben");
    expect(inner[0].parentPath).toBe("/Schrauben");
  });

  it("createFolder is idempotent and back-fills missing ancestors", async () => {
    const first = await service.createFolder("/Proj/A/Schrauben");
    const again = await service.createFolder("/Proj/A/Schrauben");
    expect(again.id).toBe(first.id);

    // Intermediate ancestors were created exactly once each.
    expect(await service.findByPath("/Proj")).not.toBeNull();
    expect(await service.findByPath("/Proj/A")).not.toBeNull();
    expect(await service.listAll()).toHaveLength(3);
  });

  it("renaming a branch moves a same-named nested subtree as a unit", async () => {
    await service.createFolder("/Schrauben/Schrauben");
    await service.renameFolder("/Schrauben", "/Bolts");

    expect(await service.findByPath("/Schrauben")).toBeNull();
    expect(await service.findByPath("/Schrauben/Schrauben")).toBeNull();
    const moved = await service.findByPath("/Bolts/Schrauben");
    expect(moved).not.toBeNull();
    expect(moved!.parentPath).toBe("/Bolts");
    expect(moved!.name).toBe("Schrauben");
  });

  it("force-deleting a branch removes its same-named descendants too", async () => {
    await service.createFolder("/Proj/A/Schrauben");
    await service.createFolder("/Proj/B/Schrauben");

    const { deletedPaths } = await service.deleteFolder("/Proj/A", { force: true });
    expect(deletedPaths.sort()).toEqual(["/Proj/A", "/Proj/A/Schrauben"]);

    // The parallel /Proj/B/Schrauben is untouched.
    expect(await service.findByPath("/Proj/A/Schrauben")).toBeNull();
    expect(await service.findByPath("/Proj/B/Schrauben")).not.toBeNull();
  });
});
