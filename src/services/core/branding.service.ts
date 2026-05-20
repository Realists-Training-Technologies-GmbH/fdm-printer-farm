import { copyFile, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { AppConstants } from "@/server.constants";
import { getMediaPath, superRootPath } from "@/utils/fs.utils";
import { LoggerService } from "@/handlers/logger";
import type { ILoggerFactory } from "@/handlers/logger-factory";

const BRANDING_DIR = "branding";
const LOGO_BASENAME = "logo";

const SUPPORTED_FORMATS = ["png", "svg"] as const;
type LogoFormat = (typeof SUPPORTED_FORMATS)[number];

export interface BrandingLogoStatus {
  customLogoEnabled: boolean;
  format: LogoFormat | null;
  size: number | null;
  uploadedAt: string | null;
}

/**
 * Manages a user-supplied logo that overrides the bundled wolf logo in the client.
 *
 * The source-of-truth file lives under `media/branding/logo.{png,svg}`. On boot,
 * after a client-bundle update, and on every upload, we mirror that file into the
 * dist folders so the existing `/img/logo.{png,svg}` and `/assets/logo-*.png`
 * URLs the frontend already requests now resolve to the user's logo — without
 * needing any frontend code changes.
 */
export class BrandingService {
  private readonly logger: LoggerService;

  constructor(loggerFactory: ILoggerFactory) {
    this.logger = loggerFactory(BrandingService.name);
  }

  // ----- public API -----

  async getStatus(): Promise<BrandingLogoStatus> {
    const sourcePath = this.findSourceLogoPath();
    if (!sourcePath) {
      return { customLogoEnabled: false, format: null, size: null, uploadedAt: null };
    }

    const stats = await stat(sourcePath);
    return {
      customLogoEnabled: true,
      format: extname(sourcePath).slice(1).toLowerCase() as LogoFormat,
      size: stats.size,
      uploadedAt: stats.mtime.toISOString(),
    };
  }

  async readSourceLogo(): Promise<{ path: string; format: LogoFormat } | null> {
    const sourcePath = this.findSourceLogoPath();
    if (!sourcePath) return null;
    return {
      path: sourcePath,
      format: extname(sourcePath).slice(1).toLowerCase() as LogoFormat,
    };
  }

  /**
   * Persist the uploaded logo as the new source-of-truth and apply it to the
   * served bundle directories.
   */
  async setCustomLogo(buffer: Buffer, originalFileName: string): Promise<BrandingLogoStatus> {
    const ext = extname(originalFileName).slice(1).toLowerCase();
    if (!SUPPORTED_FORMATS.includes(ext as LogoFormat)) {
      throw new Error(`Unsupported logo format ".${ext}". Allowed: ${SUPPORTED_FORMATS.join(", ")}`);
    }

    await this.ensureBrandingDir();

    // Remove any previous-format source so we don't keep stale png+svg side by side.
    await this.clearSourceLogos();

    const sourcePath = join(this.getBrandingDir(), `${LOGO_BASENAME}.${ext}`);
    await writeFile(sourcePath, buffer);
    this.logger.log(`Saved custom logo source to ${sourcePath} (${buffer.byteLength} bytes)`);

    await this.applyToBundles();
    return this.getStatus();
  }

  /**
   * Remove the custom logo source. The originally bundled logos remain in the
   * dist folders only if they haven't been overwritten; otherwise the next
   * client-bundle download/extract will restore them.
   */
  async clearCustomLogo(): Promise<void> {
    await this.clearSourceLogos();
    this.logger.log("Custom logo cleared. Default logo will be restored on next client bundle update.");
  }

  /**
   * Re-apply the custom logo to every bundle directory. Called on boot and
   * after `ClientDistDownloadTask` extracts a fresh bundle.
   */
  async applyToBundles(): Promise<void> {
    const source = await this.readSourceLogo();
    if (!source) {
      this.logger.debug("No custom logo configured; skipping bundle apply.");
      return;
    }

    const bundleDirs = this.getBundleDirs().filter((d) => existsSync(d));
    if (bundleDirs.length === 0) {
      this.logger.debug("No bundle directories exist yet; will retry on next boot/update.");
      return;
    }

    for (const dist of bundleDirs) {
      await this.applyToBundleDir(dist, source);
    }
  }

  // ----- internals -----

  private async applyToBundleDir(distPath: string, source: { path: string; format: LogoFormat }): Promise<void> {
    const imgDir = join(distPath, "img");
    const assetsDir = join(distPath, "assets");

    // Stable filenames the index.html and CSS reference.
    if (existsSync(imgDir)) {
      const target = join(imgDir, `${LOGO_BASENAME}.${source.format}`);
      await copyFile(source.path, target);
      this.logger.debug(`Logo applied: ${target}`);
    }

    // Hashed copies the JS bundle imports as `logo-<hash>.png` (or .svg).
    if (existsSync(assetsDir)) {
      try {
        const entries = await readdir(assetsDir);
        const hashedMatches = entries.filter((f) =>
          new RegExp(`^${LOGO_BASENAME}-[A-Za-z0-9_-]+\\.${source.format}$`).test(f),
        );
        for (const hashed of hashedMatches) {
          const target = join(assetsDir, hashed);
          await copyFile(source.path, target);
          this.logger.debug(`Logo applied: ${target}`);
        }
      } catch (e: any) {
        this.logger.warn(`Failed to enumerate assets in ${assetsDir}: ${e.message}`);
      }
    }
  }

  private findSourceLogoPath(): string | null {
    const dir = this.getBrandingDir();
    for (const format of SUPPORTED_FORMATS) {
      const candidate = join(dir, `${LOGO_BASENAME}.${format}`);
      if (existsSync(candidate)) {
        try {
          if (statSync(candidate).size > 0) return candidate;
        } catch {
          /* fall through */
        }
      }
    }
    return null;
  }

  private async clearSourceLogos(): Promise<void> {
    const dir = this.getBrandingDir();
    for (const format of SUPPORTED_FORMATS) {
      const candidate = join(dir, `${LOGO_BASENAME}.${format}`);
      if (existsSync(candidate)) {
        await rm(candidate, { force: true });
      }
    }
  }

  private async ensureBrandingDir(): Promise<void> {
    await mkdir(this.getBrandingDir(), { recursive: true });
  }

  private getBrandingDir(): string {
    return join(getMediaPath(), BRANDING_DIR);
  }

  private getBundleDirs(): string[] {
    return [
      join(getMediaPath(), AppConstants.defaultClientBundleStorage, "dist"),
      join(superRootPath(), "node_modules", AppConstants.clientPackageName, "dist"),
    ];
  }
}
