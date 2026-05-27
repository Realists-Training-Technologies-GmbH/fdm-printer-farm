import { PrusaLinkApi } from "@/services/prusa-link/prusa-link.api";
import { ExternalServiceError } from "@/exceptions/runtime.exceptions";
import EventEmitter2 from "eventemitter2";

// deleteFile/deleteFolder must turn PrusaLink's 409 ("in use") into an
// actionable message: the file is printing OR open in the Buddy print preview
// (a selected file can't be deleted). That state isn't visible in
// status/job, so the 409 is the only signal. Other errors propagate as-is.

const loggerStub = { log() {}, info() {}, debug() {}, warn() {}, error() {}, newDebug() {} };
const loggerFactory = () => loggerStub as any;
const settingsStore = { getTimeoutSettings: () => ({ apiTimeout: 1000 }) } as any;

function makeApi(deleteImpl: () => Promise<any>) {
  const api = new PrusaLinkApi(loggerFactory, new EventEmitter2(), {} as any, settingsStore, {
    printerURL: "http://prusa.test",
    printerType: 2,
    username: "maker",
    password: "secret",
  } as any);
  vi.spyOn(api as any, "getInternalStorage").mockResolvedValue("usb");
  vi.spyOn(api as any, "resolveEncodedPath").mockImplementation(async (p: string) => p);
  const del = vi.fn(deleteImpl);
  vi.spyOn(api as any, "createClient").mockReturnValue({ delete: del } as any);
  return { api, del };
}
const httpError = (status: number) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } });

describe("PrusaLinkApi delete error translation", () => {
  it("deleteFile: succeeds quietly on 204", async () => {
    const { api, del } = makeApi(async () => ({ status: 204 }));
    await expect(api.deleteFile("part.gcode")).resolves.toBeUndefined();
    expect(del).toHaveBeenCalledWith("/api/v1/files/usb/part.gcode");
  });

  it("deleteFile: 409 becomes an actionable 'in use / open in preview' error", async () => {
    const { api } = makeApi(async () => {
      throw httpError(409);
    });
    await expect(api.deleteFile("part.gcode")).rejects.toThrow(ExternalServiceError);
    await expect(api.deleteFile("part.gcode")).rejects.toMatchObject({ error: { statusCode: 409 } });
    await expect(api.deleteFile("part.gcode")).rejects.toThrow(/deselect|preview|in use/i);
  });

  it("deleteFolder: 409 mentions a file inside being in use", async () => {
    const { api } = makeApi(async () => {
      throw httpError(409);
    });
    await expect(api.deleteFolder("MyFolder")).rejects.toThrow(/folder/i);
    await expect(api.deleteFolder("MyFolder")).rejects.toThrow(/preview|in use|deselect/i);
  });

  it("deleteFile: non-409 errors propagate unchanged (e.g. 404)", async () => {
    const { api } = makeApi(async () => {
      throw httpError(404);
    });
    await expect(api.deleteFile("missing.gcode")).rejects.toThrow(/404/);
  });
});
