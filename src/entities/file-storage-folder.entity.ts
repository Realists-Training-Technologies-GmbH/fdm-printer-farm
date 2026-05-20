import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/**
 * A virtual folder in the file-storage tree.
 *
 * Folders are persisted (so empty folders survive across requests) but they
 * don't map to physical directories on disk — files keep being stored under
 * `media/files/{gcode|3mf|bgcode}/<id>` keyed by hash, and the folder
 * assignment lives in the file's metadata JSON. This keeps deduplication and
 * the hash-keyed paths intact while letting users organise things visually.
 *
 * `path` is a normalised, slash-separated, absolute string ("/clientes/empresa-x").
 * `parentPath` is `null` for top-level folders, otherwise the parent's path.
 * `name` is the last segment, kept denormalised so listing UIs don't need to
 * split the path every render.
 */
@Entity()
export class FileStorageFolder {
  @PrimaryGeneratedColumn()
  id: number;

  @Index({ unique: true })
  @Column({ type: "varchar", length: 1024 })
  path: string;

  @Index()
  @Column({ type: "varchar", length: 1024, nullable: true })
  parentPath: string | null;

  @Column({ type: "varchar", length: 255 })
  name: string;

  @CreateDateColumn()
  createdAt: Date;
}
