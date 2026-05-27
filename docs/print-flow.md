# Printing a file — end-to-end flow (PrusaLink)

How a file goes from the browser to a running print, and how live state gets
back to the dashboard. Names map to real code: `PrinterFilesController`
(`src/controllers/printer-files.controller.ts`), `PrinterApiFactory`
(`src/services/printer-api.factory.ts`), `PrusaLinkApi`
(`src/services/prusa-link/prusa-link.api.ts`), `PrusaLinkHttpPollingAdapter`,
`PrinterEventsCache`, `SocketIoTask`, `SocketIoGateway`.

## 1. Upload & start print (request path)

```mermaid
sequenceDiagram
    autonumber
    actor U as User (Vue client)
    participant API as PrinterFilesController<br/>/api/printer-files
    participant MW as printerResolveMiddleware
    participant F as PrinterApiFactory
    participant A as PrusaLinkApi
    participant P as Printer (PrusaLink HTTP, digest)

    U->>API: POST /{id}/upload (multipart file, startPrint?)
    API->>MW: @before authenticate + resolve printer
    MW->>F: getScopedPrinter(login)
    F-->>API: IPrinterApi = PrusaLinkApi (login set)
    API->>A: uploadFile({stream, fileName, contentLength, startPrint, targetPath})

    A->>P: GET /api/version  (getCapabilities, memoized)
    P-->>A: {server, capabilities.upload-by-put, text→model}
    Note over A: deriveCapabilities():<br/>supportsBgcode, uploadTransport, fileExtensions

    alt fileName .bgcode AND board can't decode (Einsy)
        A-->>API: 400 "Binary G-code cannot be printed on <model>"
    else ok
        A->>P: GET /api/v1/status (free-space + internal storage)
        P-->>A: storage[] (usb on Buddy / local on Einsy)
        alt uploadTransport = put  (Buddy: XL/MK4/MINI/Core One)
            A->>P: GET /api/version (prime digest)
            A->>P: PUT /api/v1/files/{storage}/{path}<br/>Print-After-Upload, Overwrite
        else uploadTransport = legacyMultipart  (Einsy: MK3/MK2.5)
            A->>P: POST /api/files/{storage} (multipart, path=subfolder)
        end
        P-->>A: 201 Created
        A-->>API: ok (emits uploadDone)
    end

    opt separate "print existing file"
        U->>API: POST /{id}/print {filePath}
        API->>A: startPrint(path)
        A->>P: GET /api/v1/status (refuse if PRINTING/PAUSED/BUSY/ATTENTION → 409)
        A->>P: POST /api/v1/files/{storage}/{path}
        P-->>A: 204 → printer heats, homes, prints
    end
```

## 2. Firmware decisions inside `uploadFile` (the capability profile)

`deriveCapabilities(/api/version)` centralises the firmware divergences
(mirrors how upstream Prusa-Link-Web ships a per-variant flag set, but resolved
at runtime). See `src/services/prusa-link/utils/prusa-link-capabilities.ts`.

```mermaid
flowchart TD
    Start([uploadFile]) --> Caps[getCapabilities<br/>GET /api/version, memoized]
    Caps --> Bg{fileName .bgcode<br/>and supportsBgcode == false?}
    Bg -- yes --> Rej[/reject 400:<br/>re-slice as .gcode/]
    Bg -- no --> Space[getStatus → free space check]
    Space --> Store[getInternalStorage<br/>usb Buddy / local Einsy]
    Store --> T{uploadTransport}
    T -- put<br/>Buddy --> Put[prime GET /api/version<br/>then PUT octet-stream<br/>/api/v1/files/...]
    T -- legacyMultipart<br/>Einsy --> Post[multipart POST<br/>/api/files/storage]
    Put --> PutErr{error?}
    PutErr -- 401 --> Retry[retry PUT once<br/>fresh stream]
    PutErr -- 5xx --> Post
    PutErr -- no --> Done([uploaded])
    Retry --> Done
    Post --> Done
```

## 3. Live state back to the dashboard (continuous, parallel)

Independent of any single request: a recurring poll feeds an in-memory cache,
which a second task pushes to clients over Socket.IO.

```mermaid
sequenceDiagram
    autonumber
    participant T as PrinterWebsocketTask<br/>(heartbeat)
    participant PA as PrusaLinkHttpPollingAdapter
    participant P as Printer (PrusaLink)
    participant EE as EventEmitter2
    participant C as PrinterEventsCache
    participant J as PrintJobService
    participant ST as SocketIoTask
    participant G as SocketIoGateway
    actor U as Dashboard (Vue)

    loop every PRUSA_LINK_POLL_INTERVAL_MS (~5s), skip if in-flight
        T->>PA: pollOnce()
        Note over PA,P: sequential GETs — digest nc must stay monotonic
        PA->>P: GET /api/printer
        PA->>P: GET /api/job
        PA->>P: GET /api/v1/status
        Note over PA: linkState = state.flags.link_state ?? status.printer.state<br/>(XL has no link_state → v1 fallback)<br/>map flags: ready/printing/paused/error/busy
        PA->>EE: emit prusalink.current {state, temps, job, progress, freeSpace, ...}
        EE->>C: PrinterEventsCache handles event
        C->>J: markStarted / markProgress / markFinished / handlePrintCancelled
    end

    loop SocketIoTask tick
        ST->>C: getAllKeyValues()
        ST->>G: send(IO_MESSAGES.Update, snapshot)
        G-->>U: Socket.IO → dashboard updates (state, progress, temps)
    end
```

## Notes / firmware gotchas (hardware-verified)

- **XL prints `.bgcode` only**; legacy Einsy (MK3) prints `.gcode` only — gated by `supportsBgcode`.
- **Upload transport differs**: Buddy accepts the modern `PUT`; the Einsy shim advertises `upload-by-put` but 500s on it, so it must use the legacy multipart `POST`.
- **Delete returns `409` when the file is in use** — including when it's *open in the Buddy print preview* (selected). Not visible in status/job; the adapter surfaces an actionable message (`throwDeleteError`).
- **`link_state` is Einsy-only**; the XL carries live state on `/api/v1/status.printer.state` (the polling adapter falls back to it).
- **MK3 listings are ~1s eventually consistent**; the XL is immediate.
