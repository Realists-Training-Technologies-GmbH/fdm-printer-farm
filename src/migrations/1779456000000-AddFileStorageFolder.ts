import { MigrationInterface, QueryRunner } from "typeorm";

export class AddFileStorageFolder1779456000000 implements MigrationInterface {
  name = "AddFileStorageFolder1779456000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "file_storage_folder"
      (
        "id"         integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "path"       varchar(1024) NOT NULL,
        "parentPath" varchar(1024),
        "name"       varchar(255)  NOT NULL,
        "createdAt"  datetime      NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_file_storage_folder_path" ON "file_storage_folder" ("path")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_file_storage_folder_parent" ON "file_storage_folder" ("parentPath")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_file_storage_folder_parent"`);
    await queryRunner.query(`DROP INDEX "IDX_file_storage_folder_path"`);
    await queryRunner.query(`DROP TABLE "file_storage_folder"`);
  }
}
