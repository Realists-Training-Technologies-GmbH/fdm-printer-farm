import { z } from "zod";

export const startPrintFileSchema = z.object({
  filePath: z.string().min(1),
});

export const downloadFileSchema = z.object({
  path: z.string().min(1),
});

export const getFileSchema = z.object({
  path: z.string().min(1),
});

export const uploadFileSchema = z.object({
  startPrint: z.enum(["true", "false"]),
  // Optional subfolder (display-name path) to upload into; defaults to the
  // storage root on the target firmware. Currently honored by PrusaLink only.
  targetPath: z.string().optional(),
});

export const createFolderSchema = z.object({
  path: z.string().min(1),
});

export const getFilesSchema = z.object({
  recursive: z.string().optional(),
  startDir: z.string().optional(),
});
