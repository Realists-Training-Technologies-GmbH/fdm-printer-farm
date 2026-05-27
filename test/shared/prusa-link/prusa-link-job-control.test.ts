import { PrusaLinkApi } from "@/services/prusa-link/prusa-link.api";
import { ExternalServiceError } from "@/exceptions/runtime.exceptions";
import EventEmitter2 from "eventemitter2";

// Job control (pause/resume/cancel) routes through runJobControl, which:
//  - uses the v1 /api/v1/job/{id}/... endpoint when a job id is present,
//  - falls back to the legacy OctoPrint-compat POST /api/job when v1 rejects
//    (404/409/405) OR when the id is missing but the printer is active/ATTENTION,
//  - and rejects clearly when the printer is idle (no job to act on) instead of
//    firing the legacy command, which the MK3 silently accepts as a no-op.

const loggerStub = { log() {}, info() {}, debug() {}, warn() {}, error() {}, newDebug() {} };
const loggerFactory = () => loggerStub as any;
const settingsStore = { getTimeoutSettings: () => ({ apiTimeout: 1000 }) } as any;

function makeApi(status: any) {
  const api = new PrusaLinkApi(loggerFactory, new EventEmitter2(), {} as any, settingsStore, {
    printerURL: "http://prusa.test",
    printerType: 2,
    username: "maker",
    password: "secret",
  } as any);
  vi.spyOn(api as any, "getStatus").mockResolvedValue(status);
  const client = {
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
    get: vi.fn().mockResolvedValue({}),
  };
  vi.spyOn(api as any, "createClient").mockReturnValue(client as any);
  return { api, client };
}

describe("PrusaLinkApi job control (runJobControl)", () => {
  it("cancel: with an active job uses the v1 endpoint and skips the legacy fallback", async () => {
    const { api, client } = makeApi({ printer: { state: "PRINTING" }, job: { id: 1 } });
    await api.cancelPrint();
    expect(client.delete).toHaveBeenCalledWith("/api/v1/job/1");
    expect(client.post).not.toHaveBeenCalled();
  });

  it("pause: maps to the v1 pause endpoint for the active job id", async () => {
    const { api, client } = makeApi({ printer: { state: "PRINTING" }, job: { id: 7 } });
    await api.pausePrint();
    expect(client.put).toHaveBeenCalledWith("/api/v1/job/7/pause");
    expect(client.post).not.toHaveBeenCalled();
  });

  it("cancel: while idle rejects with 'No active print' and never calls the legacy command", async () => {
    const { api, client } = makeApi({ printer: { state: "IDLE" }, job: undefined });
    await expect(api.cancelPrint()).rejects.toMatchObject({ error: { statusCode: 409 } });
    await expect(api.cancelPrint()).rejects.toThrow(/no active print/i);
    expect(client.post).not.toHaveBeenCalled();
    expect(client.delete).not.toHaveBeenCalled();
  });

  it("pause: while idle rejects and does not fire the legacy command", async () => {
    const { api, client } = makeApi({ printer: { state: "IDLE" }, job: undefined });
    await expect(api.pausePrint()).rejects.toThrow(ExternalServiceError);
    expect(client.post).not.toHaveBeenCalled();
  });

  it("cancel: in ATTENTION with no job id falls back to the legacy command", async () => {
    const { api, client } = makeApi({ printer: { state: "ATTENTION" }, job: undefined });
    await api.cancelPrint();
    expect(client.post).toHaveBeenCalledWith("/api/job", { command: "cancel" });
  });

  it("cancel: when the v1 endpoint rejects 409 it falls back to the legacy command", async () => {
    const { api, client } = makeApi({ printer: { state: "PRINTING" }, job: { id: 5 } });
    client.delete.mockRejectedValueOnce(Object.assign(new Error("409"), { response: { status: 409 } }));
    await api.cancelPrint();
    expect(client.delete).toHaveBeenCalledWith("/api/v1/job/5");
    expect(client.post).toHaveBeenCalledWith("/api/job", { command: "cancel" });
  });
});
