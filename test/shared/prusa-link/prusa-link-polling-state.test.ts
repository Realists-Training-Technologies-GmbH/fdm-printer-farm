import { PrusaLinkHttpPollingAdapter } from "@/services/prusa-link/prusa-link-http-polling.adapter";
import { prusaLinkEvent } from "@/services/prusa-link/constants/prusalink.constants";
import EventEmitter2 from "eventemitter2";

// The flag mapping must work on both firmwares:
//  - Einsy/MK3 emits state.flags.link_state on /api/printer
//  - Buddy/XL does NOT; it carries live state on /api/v1/status.printer.state
// Without the v1 fallback the XL's flags get clobbered (ready:false idle,
// printing:false mid-print). These tests capture the emitted "current" event.

const loggerStub = { log() {}, info() {}, debug() {}, warn() {}, error() {}, newDebug() {} };

function makeAdapter(printerStateFlags: any, v1State: string | undefined) {
  const ee = new EventEmitter2();
  const prusaLinkApi: any = {
    login: {},
    getPrinterState: vi.fn().mockResolvedValue({
      state: { text: "Operational", flags: printerStateFlags },
      temperature: { tool0: { actual: 30, target: 0 }, bed: { actual: 30, target: 0 } },
    }),
    getJobState: vi.fn().mockResolvedValue({ job: null, progress: {} }),
    getStatus: vi.fn().mockResolvedValue(v1State ? { printer: { state: v1State } } : null),
  };
  const adapter = new PrusaLinkHttpPollingAdapter(() => loggerStub as any, prusaLinkApi, ee);
  adapter.registerCredentials({
    loginDto: { printerURL: "http://prusa.test", username: "m", password: "p", printerType: 2 },
    printerId: 1,
  } as any);
  return { adapter, ee };
}

async function capturePoll(adapter: PrusaLinkHttpPollingAdapter, ee: EventEmitter2) {
  let payload: any;
  ee.on(prusaLinkEvent("current"), (msg: any) => {
    payload = msg.payload;
  });
  await (adapter as any).pollOnce();
  return payload;
}

describe("PrusaLinkHttpPollingAdapter flag mapping", () => {
  it("XL (no link_state, v1 status IDLE): ready=true, printing=false", async () => {
    const { adapter, ee } = makeAdapter(
      { operational: true, ready: true, printing: false }, // XL native flags, no link_state
      "IDLE",
    );
    const payload = await capturePoll(adapter, ee);
    expect(payload.state.flags.ready).toBe(true);
    expect(payload.state.flags.printing).toBe(false);
    expect(payload.state.flags.operational).toBe(true);
  });

  it("XL mid-print (no link_state, v1 status PRINTING): printing=true, ready=false", async () => {
    const { adapter, ee } = makeAdapter({ operational: true, ready: false, printing: true }, "PRINTING");
    const payload = await capturePoll(adapter, ee);
    expect(payload.state.flags.printing).toBe(true);
    expect(payload.state.flags.ready).toBe(false);
  });

  it("MK3 (link_state present) still drives the mapping", async () => {
    const { adapter, ee } = makeAdapter({ operational: true, link_state: "PAUSED" }, "PAUSED");
    const payload = await capturePoll(adapter, ee);
    expect(payload.state.flags.paused).toBe(true);
    expect(payload.state.flags.printing).toBe(false);
  });

  it("ATTENTION still flags error + keeps printing true (job stays loaded)", async () => {
    const { adapter, ee } = makeAdapter({ link_state: "ATTENTION" }, "ATTENTION");
    const payload = await capturePoll(adapter, ee);
    expect(payload.state.flags.error).toBe(true);
    expect(payload.state.flags.printing).toBe(true);
  });
});
