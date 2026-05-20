import { AppConstants } from "@/server.constants";
import { ClientBundleService } from "@/services/core/client-bundle.service";
import { BrandingService } from "@/services/core/branding.service";
import { LoggerService } from "@/handlers/logger";
import type { ILoggerFactory } from "@/handlers/logger-factory";

export class ClientDistDownloadTask {
  private readonly logger: LoggerService;

  constructor(
    loggerFactory: ILoggerFactory,
    private readonly clientBundleService: ClientBundleService,
    private readonly brandingService: BrandingService,
  ) {
    this.logger = loggerFactory(ClientDistDownloadTask.name);
  }

  async run() {
    const result = await this.clientBundleService.shouldUpdateWithReason(false, AppConstants.defaultClientMinimum);
    if (!result.shouldUpdate) {
      this.logger.log(`Client bundle update skipped. Reason: ${result.reason}`);
      return;
    }

    this.logger.log(`Client bundle update required. Reason for updating: ${result.reason}`);

    await this.clientBundleService.downloadClientUpdate(AppConstants.defaultClientMinimum);

    // The extract wipes the dist folder, so any custom logo overrides are gone.
    // Re-apply from the persisted source under media/branding so the user's
    // logo survives a bundle update.
    try {
      await this.brandingService.applyToBundles();
    } catch (e: any) {
      this.logger.warn(`Failed to re-apply custom branding after bundle update: ${e.message}`);
    }
  }
}
