import { PrusaLinkApi } from "@/services/prusa-link/prusa-link.api";
import { ExternalServiceError } from "@/exceptions/runtime.exceptions";
import EventEmitter2 from "eventemitter2";
import { Readable } from "node:stream";

// getFileThumbnail must read the PrusaLink Web API file refs as
// `icon` (small) / `thumbnail` (big) — NOT the legacy `thumbnailSmall` /
// `thumbnailBig` keys, which never exist on real hardware and made every
// thumbnail request 404. These tests lock that contract.

const loggerStub = { log() {}, info() {}, debug() {}, warn() {}, error() {}, newDebug() {} };
const loggerFactory = () => loggerStub as any;
const settingsStore = { getTimeoutSettings: () => ({ apiTimeout: 1000, apiUploadTimeout: 1000 }) } as any;

function makeApi(refs: any) {
  const api = new PrusaLinkApi(
    loggerFactory,
    new EventEmitter2(),
    {} as any, // httpClientFactory — unused, createClient() is stubbed below
    settingsStore,
    { printerURL: "http://prusa.test", printerType: 2, username: "maker", password: "secret" } as any,
  );
  // Short-circuit the storage/path resolution so the test targets the
  // variant → refs-key selection only.
  vi.spyOn(api as any, "getInternalStorage").mockResolvedValue("usb");
  vi.spyOn(api as any, "resolveEncodedPath").mockImplementation(async (p: string) => p);
  vi.spyOn(api as any, "getFileRaw").mockResolvedValue({ data: { refs } });

  const get = vi.fn().mockResolvedValue({
    status: 200,
    data: Readable.from(Buffer.from("png-bytes")),
    headers: { "content-type": "image/png" },
  });
  vi.spyOn(api as any, "createClient").mockReturnValue({ get } as any);
  return { api, get };
}

describe("PrusaLinkApi.getFileThumbnail", () => {
  const REFS = { icon: "/thumb/s/usb/F.BGC", thumbnail: "/thumb/l/usb/F.BGC", download: "/usb/F.BGC" };

  it("big variant streams refs.thumbnail", async () => {
    const { api, get } = makeApi(REFS);
    const res = await api.getFileThumbnail("F.bgcode", "big");
    expect(get).toHaveBeenCalledWith("/thumb/l/usb/F.BGC", { responseType: "stream" });
    expect(res.status).toBe(200);
  });

  it("small variant streams refs.icon", async () => {
    const { api, get } = makeApi(REFS);
    await api.getFileThumbnail("F.bgcode", "small");
    expect(get).toHaveBeenCalledWith("/thumb/s/usb/F.BGC", { responseType: "stream" });
  });

  it("falls back to the big thumbnail when the small icon is absent", async () => {
    const { api, get } = makeApi({ icon: null, thumbnail: "/thumb/l/usb/F.BGC", download: "/usb/F.BGC" });
    await api.getFileThumbnail("F.bgcode", "small");
    expect(get).toHaveBeenCalledWith("/thumb/l/usb/F.BGC", { responseType: "stream" });
  });

  it("throws a 404-style ExternalServiceError when no thumbnail refs exist", async () => {
    const { api, get } = makeApi({ icon: null, thumbnail: null, download: "/usb/F.gcode" });
    await expect(api.getFileThumbnail("F.gcode", "big")).rejects.toThrow(/thumbnail/i);
    expect(get).not.toHaveBeenCalled();
  });

  it("ignores the legacy thumbnailSmall/thumbnailBig keys (regression guard)", async () => {
    // A payload carrying ONLY the legacy keys must be treated as "no thumbnail".
    const { api } = makeApi({
      thumbnailSmall: "/legacy/s",
      thumbnailBig: "/legacy/l",
      download: "/usb/F.gcode",
    } as any);
    await expect(api.getFileThumbnail("F.bgcode", "big")).rejects.toThrow(ExternalServiceError);
  });
});
