import { before, DELETE, GET, POST, route } from "awilix-express";
import type { Request, Response } from "express";
import { authenticate, authorizeRoles } from "@/middleware/authenticate";
import { demoUserNotAllowed } from "@/middleware/demo.middleware";
import { ROLES } from "@/constants/authorization.constants";
import { AppConstants } from "@/server.constants";
import { BrandingService } from "@/services/core/branding.service";
import { MulterService } from "@/services/core/multer.service";
import { BadRequestException, ValidationException } from "@/exceptions/runtime.exceptions";
import { createReadStream } from "node:fs";
import { extname } from "node:path";
import { readFile } from "node:fs/promises";
import { LoggerService } from "@/handlers/logger";
import type { ILoggerFactory } from "@/handlers/logger-factory";

@route(AppConstants.apiRoute + "/branding")
@before([authenticate()])
export class BrandingController {
  private readonly logger: LoggerService;

  constructor(
    loggerFactory: ILoggerFactory,
    private readonly brandingService: BrandingService,
    private readonly multerService: MulterService,
  ) {
    this.logger = loggerFactory(BrandingController.name);
  }

  /**
   * Public read — any authenticated user may inspect the current branding so
   * the client can decide whether to show "custom logo active" indicators.
   */
  @GET()
  @route("/logo")
  async getLogoStatus(_req: Request, res: Response) {
    const status = await this.brandingService.getStatus();
    res.send(status);
  }

  /**
   * Serve the raw source-of-truth logo. Useful as a stable URL the admin panel
   * can use for previews independent of the hashed bundle asset names.
   */
  @GET()
  @route("/logo/file")
  async getLogoFile(_req: Request, res: Response) {
    const source = await this.brandingService.readSourceLogo();
    if (!source) {
      res.status(404).send({ error: "No custom logo configured" });
      return;
    }

    const contentType = source.format === "svg" ? "image/svg+xml" : "image/png";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "no-cache");
    createReadStream(source.path).pipe(res);
  }

  @POST()
  @route("/logo")
  @before([authorizeRoles([ROLES.ADMIN]), demoUserNotAllowed])
  async uploadLogo(req: Request, res: Response) {
    const files = await this.multerService.multerLoadFileAsync(req, res, [".png", ".svg"], false);

    if (!files?.length) {
      throw new BadRequestException("No logo file uploaded");
    }
    if (files.length > 1) {
      throw new ValidationException({ error: "Only 1 logo can be uploaded at a time" });
    }

    const file = files[0];
    const ext = extname(file.originalname).toLowerCase();
    if (ext !== ".png" && ext !== ".svg") {
      throw new ValidationException({ error: "Logo must be a .png or .svg file" });
    }

    // multer was configured with memoryStorage (storeAsFile=false) so the buffer is in-memory.
    const buffer = file.buffer ?? (file.path ? await readFile(file.path) : null);
    if (!buffer || buffer.byteLength === 0) {
      throw new BadRequestException("Uploaded logo is empty");
    }

    const status = await this.brandingService.setCustomLogo(buffer, file.originalname);
    this.logger.log(`Custom logo updated (${status.format}, ${status.size} bytes)`);

    res.send(status);
  }

  @DELETE()
  @route("/logo")
  @before([authorizeRoles([ROLES.ADMIN]), demoUserNotAllowed])
  async deleteLogo(_req: Request, res: Response) {
    await this.brandingService.clearCustomLogo();
    this.logger.log("Custom logo removed");
    res.send({ customLogoEnabled: false, format: null, size: null, uploadedAt: null });
  }
}
