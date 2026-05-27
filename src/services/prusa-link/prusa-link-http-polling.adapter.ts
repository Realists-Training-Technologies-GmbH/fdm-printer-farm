import { PrusaLinkType } from "@/services/printer-api.interface";
import { PrusaLinkApi } from "@/services/prusa-link/prusa-link.api";
import { LoggerService } from "@/handlers/logger";
import EventEmitter2 from "eventemitter2";
import type { ILoggerFactory } from "@/handlers/logger-factory";
import type { IWebsocketAdapter } from "@/services/websocket-adapter.interface";
import type { ISocketLogin } from "@/shared/dtos/socket-login.dto";
import type { LoginDto } from "@/services/interfaces/login.dto";
import { SOCKET_STATE, SocketState } from "@/shared/dtos/socket-state.type";
import { API_STATE, ApiState } from "@/shared/dtos/api-state.type";
import { errorSummary } from "@/utils/error.utils";
import { prusaLinkEvent } from "@/services/prusa-link/constants/prusalink.constants";
import type { PrusaLinkEventDto } from "@/services/prusa-link/constants/prusalink-event.dto";
import { WsMessage } from "@/services/octoprint/octoprint-websocket.adapter";
import { AppConstants } from "@/server.constants";

const defaultLog = { adapter: "prusa-link" };

export class PrusaLinkHttpPollingAdapter implements IWebsocketAdapter {
  public readonly printerType = PrusaLinkType;
  public printerId?: number;
  login: LoginDto;
  socketState: SocketState;
  apiState: ApiState;
  lastMessageReceivedTimestamp: null | number;
  protected logger: LoggerService;
  private refreshPrinterCurrentInterval?: NodeJS.Timeout;
  private pollInFlight: boolean = false;
  private consecutiveAuthFailures: number = 0;

  private eventEmittingAllowed: boolean = true;

  constructor(
    loggerFactory: ILoggerFactory,
    private readonly prusaLinkApi: PrusaLinkApi,
    private readonly eventEmitter2: EventEmitter2,
  ) {
    this.logger = loggerFactory(PrusaLinkHttpPollingAdapter.name);
  }

  public allowEmittingEvents() {
    this.eventEmittingAllowed = true;
  }

  public disallowEmittingEvents() {
    this.eventEmittingAllowed = false;
  }

  needsReopen(): boolean {
    // TODO this can be standardized
    return !this.refreshPrinterCurrentInterval;
  }

  needsSetup(): boolean {
    // TODO this can be standardized
    return !this.refreshPrinterCurrentInterval;
  }

  needsReauth(): boolean {
    throw new Error("Method not implemented.");
  }

  isClosedOrAborted(): boolean {
    throw new Error("Method not implemented.");
  }

  reauthSession(): Promise<void> {
    throw new Error("Method not implemented.");
  }

  registerCredentials(socketLogin: ISocketLogin): void {
    this.login = socketLogin.loginDto;
    this.printerId = socketLogin.printerId;
  }

  open(): void {
    this.startPolling();
  }

  close(): void {
    this.logger.debug("Polling adapter attempting stoppage.", this.logMeta());
    this.stopPolling();
  }

  setupSocketSession(): Promise<void> {
    this.logger.warn("SetupSocketSession", defaultLog);
    return Promise.resolve();
  }

  resetSocketState(): void {
    this.logger.warn("ResetSocketState", defaultLog);
  }

  startPolling() {
    this.stopPolling(); // Ensure no duplicate intervals exist

    const intervalMs = this.resolvePollIntervalMs();
    this.logger.debug(`Polling adapter starting at ${intervalMs}ms interval.`, this.logMeta());

    this.refreshPrinterCurrentInterval = setInterval(() => {
      void this.pollOnce();
    }, intervalMs);
  }

  /**
   * Read the env-configured polling cadence, clamped to a sane range so a
   * typo can't melt the printer's HTTP server (e.g. `PRUSA_LINK_POLL_INTERVAL_MS=1`).
   */
  private resolvePollIntervalMs(): number {
    const raw = process.env[AppConstants.PRUSA_LINK_POLL_INTERVAL_MS];
    if (!raw) return AppConstants.defaultPrusaLinkPollIntervalMs;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return AppConstants.defaultPrusaLinkPollIntervalMs;
    return Math.min(AppConstants.maxPrusaLinkPollIntervalMs, Math.max(AppConstants.minPrusaLinkPollIntervalMs, parsed));
  }

  private async pollOnce(): Promise<void> {
    if (!this.printerId) {
      this.logger.warn("Printer ID is not set, skipping status check.", this.logMeta());
      this.stopPolling();
      return;
    }

    // PrusaLink's HTTP server is single-threaded and slow under digest auth.
    // If the previous tick is still in flight, skip this one rather than
    // stacking parallel requests that would all time out together.
    if (this.pollInFlight) {
      this.logger.debug("Previous PrusaLink poll still in flight, skipping tick.", this.logMeta());
      return;
    }
    this.pollInFlight = true;

    this.updateSocketState(SOCKET_STATE.opening);
    try {
      this.prusaLinkApi.login = {
        printerURL: this.login.printerURL,
        username: this.login.username,
        password: this.login.password,
        apiKey: "",
        printerType: PrusaLinkType,
      };
      this.updateSocketState(SOCKET_STATE.authenticating);
      // These reads run sequentially on purpose. HTTP Digest auth uses a
      // per-nonce request counter (`nc`) that must increase monotonically;
      // firing the three GETs concurrently makes them race on the shared
      // counter. Buddy firmware (MK4) tolerates out-of-order nc, but the
      // standalone PrusaLink on a Raspberry Pi (MK3/MK2.5) validates it
      // strictly and 401s whichever request loses the race. Serialising
      // keeps the nc sequence clean for every PrusaLink variant; the
      // latency cost is a few tens of ms per 5s poll.
      const printerState = await this.prusaLinkApi.getPrinterState();
      const jobState = await this.prusaLinkApi.getJobState();
      const status = await this.prusaLinkApi.getStatus().catch(() => null);
      this.updateSocketState(SOCKET_STATE.authenticated);
      this.updateApiState(API_STATE.responding);
      this.consecutiveAuthFailures = 0;

      // Native/Buddy PrusaLink (XL, MK4, …) does NOT emit `link_state` on
      // /api/printer — it carries the live state on /api/v1/status instead.
      // The legacy Einsy shim (MK3/MK2.5) emits `link_state`. Fall back to the
      // v1 status state so the flag mapping below works on every firmware;
      // without this the XL's flags get clobbered to all-false (e.g.
      // ready:false while idle, printing:false mid-print).
      const linkState = printerState.state?.flags?.link_state ?? status?.printer?.state;
      const attentionMessage = status?.printer?.status_printer?.message;
      if (linkState && linkState !== "PRINTING") {
        // When the printer is in ATTENTION, surface the firmware's reason
        // ("Filament runout", "Heating error", etc.) instead of the bare
        // state label so the dashboard tells the user what to fix.
        if (linkState.toUpperCase() === "ATTENTION" && attentionMessage) {
          printerState.state.text = `ATTENTION: ${attentionMessage}`;
        } else {
          printerState.state.text = linkState;
        }
      }

      // Map PrusaLink's link_state to the boolean flag set the dashboard reads.
      // The previous "operational = !error" shortcut hid genuine BUSY/ATTENTION
      // states; we'd rather show what the printer actually reports.
      const flags = printerState.state?.flags;
      if (flags) {
        const ls = (linkState ?? "").toUpperCase();
        flags.operational = ls !== "ERROR";
        // ATTENTION still has a job loaded and "running" from the firmware's
        // perspective — keep `printing: true` so the dashboard shows the
        // pause/cancel controls instead of hiding them as if no job was
        // active. The `error: true` flag below tells the UI to still surface
        // the attention banner.
        flags.printing = ls === "PRINTING" || ls === "ATTENTION";
        flags.paused = ls === "PAUSED";
        flags.pausing = ls === "PAUSING";
        flags.cancelling = ls === "STOPPED" || ls === "CANCELLING";
        flags.error = ls === "ERROR" || ls === "ATTENTION";
        flags.closedOnError = ls === "ERROR";
        flags.ready = ls === "READY" || ls === "IDLE" || ls === "OPERATIONAL" || ls === "FINISHED";
        flags.busy = ls === "BUSY";
      }

      // Avoid `undefined * 100 = NaN` propagating to the dashboard.
      const rawCompletion = jobState.progress?.completion;
      const completion = typeof rawCompletion === "number" ? rawCompletion * 100 : null;

      // Extra telemetry from /api/v1/status — z height, fans, axis positions,
      // and an in-flight transfer indicator (handy while a print file is
      // streaming up to the printer).
      const richTelemetry = status?.printer
        ? {
            zHeight: (status.printer as any).axis_z ?? null,
            fanHotend: status.printer.fan_hotend ?? null,
            fanPrint: status.printer.fan_print ?? null,
            speed: status.printer.speed ?? null,
            flow: status.printer.flow ?? null,
          }
        : null;
      const transfer = status?.transfer
        ? {
            id: status.transfer.id,
            progress: status.transfer.progress,
            bytes: status.transfer.data_transferred,
            timeTransferring: status.transfer.time_transferring,
          }
        : null;
      // `storage` is a single object on Buddy firmware but an array on the
      // Einsy shim (MK3/MK2.5). Report the writable storage's free space
      // (where uploads/prints land), falling back to the first reported one.
      const storageList = Array.isArray(status?.storage) ? status.storage : status?.storage ? [status.storage] : [];
      const freeSpace = (storageList.find((s) => !s.read_only) ?? storageList[0])?.free_space ?? null;
      // Carry the firmware's own status text alongside the link_state mapping
      // so the frontend can show a tooltip with the printer's exact reason
      // for the current state (especially during ATTENTION).
      const printerMessage = status?.printer?.status_printer?.message ?? null;

      // The rest of the system (PrinterControlDialog, attention helper,
      // tile temperature overlay) expects an OctoPrint-style `temps`
      // array. PrusaLink only sends a single-snapshot `temperature`
      // object; mirror it into a one-element array so consumers stay
      // adapter-agnostic.
      const temperature = (printerState as any)?.temperature;
      const tempsArray =
        temperature?.tool0 || temperature?.bed
          ? [
              {
                time: Math.floor(Date.now() / 1000),
                tool0: temperature?.tool0,
                bed: temperature?.bed,
              },
            ]
          : (printerState as any)?.temps;

      await this.emitEvent("current", {
        ...printerState,
        temps: tempsArray,
        job: jobState.job,
        progress: {
          printTime: jobState.progress?.printTime ?? null,
          printTimeLeft: jobState.progress?.printTimeLeft ?? null,
          completion,
        },
        telemetry: richTelemetry ?? (printerState as any).telemetry ?? null,
        transfer,
        freeSpace,
        printerMessage,
      });
    } catch (error) {
      this.updateSocketState(SOCKET_STATE.error);

      // Throttle log noise when the printer is unreachable or credentials are
      // wrong — we'd otherwise spam the log every 5s. After 3 consecutive
      // failures, only log once per minute.
      const status = (error as any)?.response?.status;
      const isAuthFailure = status === 401 || status === 403;
      if (isAuthFailure) this.consecutiveAuthFailures++;
      else this.consecutiveAuthFailures = 0;

      const shouldLog = this.consecutiveAuthFailures <= 3 || this.consecutiveAuthFailures % 12 === 0;
      if (shouldLog) {
        this.logger.error(`Failed to fetch PrusaLink status ${errorSummary(error)}`, this.logMeta());
      }
    } finally {
      this.pollInFlight = false;
    }
  }

  stopPolling() {
    if (this.refreshPrinterCurrentInterval) {
      this.logger.debug("Polling adapter stopping, clearing interval.", this.logMeta());
      clearInterval(this.refreshPrinterCurrentInterval);
      this.refreshPrinterCurrentInterval = undefined;
      this.updateSocketState(SOCKET_STATE.closed);
    }
  }

  private async emitEvent(event: string, payload?: any) {
    if (!this.eventEmittingAllowed) {
      return;
    }

    this.logger.debug(`Emitting event ${prusaLinkEvent(event)}`, this.logMeta());
    await this.eventEmitter2.emitAsync(prusaLinkEvent(event), {
      event,
      payload,
      printerId: this.printerId,
      printerType: PrusaLinkType,
    } as PrusaLinkEventDto);
  }

  private emitEventSync(event: string, payload: any): void {
    if (!this.eventEmittingAllowed) {
      return;
    }

    this.eventEmitter2.emit(prusaLinkEvent(event), {
      event,
      payload,
      printerId: this.printerId,
      printerType: PrusaLinkType,
    } as PrusaLinkEventDto);
  }

  private updateSocketState(state: SocketState): void {
    this.socketState = state;
    this.emitEventSync(WsMessage.WS_STATE_UPDATED, state);
  }

  private updateApiState(state: ApiState): void {
    this.apiState = state;
    this.emitEventSync(WsMessage.API_STATE_UPDATED, state);
  }

  private logMeta() {
    return defaultLog;
  }
}
