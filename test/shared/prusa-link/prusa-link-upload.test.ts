import { PrusaLinkApi } from "@/services/prusa-link/prusa-link.api";
import { ExternalServiceError } from "@/exceptions/runtime.exceptions";
import EventEmitter2 from "eventemitter2";
import { Readable } from "node:stream";

// Characterization tests for uploadFile's firmware-divergent behaviour:
//  - Buddy (XL): modern PUT octet-stream to /api/v1/files/{storage}/{file}
//  - Einsy (MK3): legacy OctoPrint-compat multipart POST /api/files/{storage}
//  - .bgcode rejected on Einsy (can't decode binary gcode)
//  - Print-After-Upload / Overwrite headers
// These lock current behaviour so the capability-profile refactor can be
// proven non-behaviour-changing.

const loggerStub = { log() {}, info() {}, debug() {}, warn() {}, error() {}, newDebug() {} };
const loggerFactory = () => loggerStub as any;
const settingsStore = { getTimeoutSettings: () => ({ apiTimeout: 1000, apiUploadTimeout: 1000 }) } as any;

function makeApi(versionText: string, original = "") {
  const api = new PrusaLinkApi(loggerFactory, new EventEmitter2(), {} as any, settingsStore, {
    printerURL: "http://prusa.test",
    printerType: 2,
    username: "maker",
    password: "secret",
  } as any);
  vi.spyOn(api as any, "getVersionInfo").mockResolvedValue({
    api: "2.0.0",
    server: "1.0.0",
    text: versionText,
    original,
    capabilities: { "upload-by-put": true },
  });
  vi.spyOn(api as any, "getStatus").mockResolvedValue({ printer: { state: "IDLE" } });
  vi.spyOn(api as any, "getInternalStorage").mockResolvedValue(versionText.includes("XL") ? "usb" : "local");
  const client = {
    get: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({ data: {} }),
    post: vi.fn().mockResolvedValue({ data: {} }),
  };
  vi.spyOn(api as any, "createClient").mockReturnValue(client as any);
  return { api, client };
}
const buf = Buffer.from("G28\n");
const input = (fileName: string, startPrint = false) => ({
  stream: Readable.from(buf),
  streamFactory: () => Readable.from(buf),
  fileName,
  contentLength: buf.length,
  startPrint,
});

describe("PrusaLinkApi.uploadFile transport selection", () => {
  it("XL (Buddy): uploads via PUT to /api/v1/files/{storage}/{file}, no legacy POST", async () => {
    const { api, client } = makeApi("PrusaLink XL");
    await api.uploadFile(input("part.gcode"));
    expect(client.put).toHaveBeenCalledTimes(1);
    const [url, , cfg] = client.put.mock.calls[0];
    expect(url).toBe("/api/v1/files/usb/part.gcode");
    expect(cfg.headers["Print-After-Upload"]).toBe("?0");
    expect(cfg.headers["Overwrite"]).toBe("?1");
    expect(client.post).not.toHaveBeenCalled();
  });

  it("XL: startPrint=true sets Print-After-Upload ?1", async () => {
    const { api, client } = makeApi("PrusaLink XL");
    await api.uploadFile(input("part.gcode", true));
    expect(client.put.mock.calls[0][2].headers["Print-After-Upload"]).toBe("?1");
  });

  it("MK3 (Einsy): uploads via legacy multipart POST /api/files/{storage}, no PUT", async () => {
    const { api, client } = makeApi("PrusaLink", "PrusaLink I3MK3S");
    await api.uploadFile(input("part.gcode"));
    expect(client.post).toHaveBeenCalledTimes(1);
    expect(client.post.mock.calls[0][0]).toBe("/api/files/local");
    expect(client.put).not.toHaveBeenCalled();
  });

  it("MK3 (Einsy): rejects a .bgcode upload (board can't decode binary gcode)", async () => {
    const { api, client } = makeApi("PrusaLink", "PrusaLink MK3S+");
    await expect(api.uploadFile(input("part.bgcode"))).rejects.toThrow(/bgcode/i);
    expect(client.put).not.toHaveBeenCalled();
    expect(client.post).not.toHaveBeenCalled();
  });

  it("XL: accepts a .bgcode upload via PUT", async () => {
    const { api, client } = makeApi("PrusaLink XL");
    await api.uploadFile(input("part.bgcode"));
    expect(client.put).toHaveBeenCalledTimes(1);
    expect(client.put.mock.calls[0][0]).toBe("/api/v1/files/usb/part.bgcode");
  });
});
