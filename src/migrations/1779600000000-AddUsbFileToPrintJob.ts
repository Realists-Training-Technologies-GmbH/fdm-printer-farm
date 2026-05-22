import { MigrationInterface, QueryRunner } from "typeorm";

export class AddUsbFileToPrintJob1779600000000 implements MigrationInterface {
  name = "AddUsbFileToPrintJob1779600000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "print_job" ADD COLUMN "usbFilePath" varchar`);
    await queryRunner.query(`ALTER TABLE "print_job" ADD COLUMN "usbDisplayName" varchar`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "print_job" DROP COLUMN "usbDisplayName"`);
    await queryRunner.query(`ALTER TABLE "print_job" DROP COLUMN "usbFilePath"`);
  }
}
