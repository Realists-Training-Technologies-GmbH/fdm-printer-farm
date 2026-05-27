import { PrusaLinkApi } from "@/services/prusa-link/prusa-link.api";
import EventEmitter2 from "eventemitter2";

// listCameras must return the firmware payload as an array, unwrap the
// `camera_list` envelope, and — crucially — treat a 404 (firmware without the
// cameras endpoint, e.g. the XL's 2.1.2) as "no cameras" rather than throwing,
// so the camera UI degrades gracefully. Non-404 errors must still propagate.

const loggerStub = { log() {}, info() {}, debug() {}, warn() {}, error() {}, newDebug() {} };
const loggerFactory = () => loggerStub as any;
const settingsStore = { getTimeoutSettings: () => ({ apiTimeout: 1000 }) } as any;

function makeApi(getImpl: () => Promise<any>) {
  const api = new PrusaLinkApi(loggerFactory, new EventEmitter2(), {} as any, settingsStore, {
    printerURL: "http://prusa.test",
    printerType: 2,
    username: "maker",
    password: "secret",
  } as any);
  const get = vi.fn(getImpl);
  vi.spyOn(api as any, "createClient").mockReturnValue({ get } as any);
  return { api, get };
}

describe("PrusaLinkApi.listCameras", () => {
  it("returns a bare array payload as-is", async () => {
    const { api } = makeApi(async () => ({ data: [{ camera_id: "a" }, { camera_id: "b" }] }));
    await expect(api.listCameras()).resolves.toEqual([{ camera_id: "a" }, { camera_id: "b" }]);
  });

  it("unwraps the camera_list envelope", async () => {
    const { api } = makeApi(async () => ({ data: { camera_list: [{ camera_id: "x" }] } }));
    await expect(api.listCameras()).resolves.toEqual([{ camera_id: "x" }]);
  });

  it("returns [] when the envelope has no camera_list", async () => {
    const { api } = makeApi(async () => ({ data: {} }));
    await expect(api.listCameras()).resolves.toEqual([]);
  });

  it("treats a 404 (no cameras endpoint) as an empty list", async () => {
    const { api } = makeApi(async () => {
      throw Object.assign(new Error("Request failed with status code 404"), { response: { status: 404 } });
    });
    await expect(api.listCameras()).resolves.toEqual([]);
  });

  it("re-throws non-404 errors (auth/server/network)", async () => {
    const { api } = makeApi(async () => {
      throw Object.assign(new Error("boom"), { response: { status: 500 } });
    });
    await expect(api.listCameras()).rejects.toThrow("boom");
  });
});
