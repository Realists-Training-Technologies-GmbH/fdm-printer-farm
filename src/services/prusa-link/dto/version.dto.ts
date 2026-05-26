export interface VersionDto {
  api: string;
  server: string;
  nozzle_diameter: number;
  text: string;
  hostname: string;
  // Legacy standalone PrusaLink (MK3/MK2.5) reports the model here (e.g.
  // "PrusaLink I3MK3S") while `text` only carries the version string.
  original?: string;
  capabilities: Capabilities;
}

export interface Capabilities {
  "upload-by-put": boolean;
}
