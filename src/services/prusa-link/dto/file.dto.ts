export interface PL_FilesDto {
  name: string;
  path: string;
  display: string;
  type: string;
  origin: string;
  children: ChildDto[];
}

/**
 * This DTO is not a child of PL_FilesDto, but instead separately defined.
 */
export interface PL_FileDto {
  name: string;
  origin: string; // local
  size: number;
  refs: RefsDto;
  // PrusaLink (modern `/api/v1/files/usb/<path>`) returns the long original
  // filename here; `name` itself is the FAT 8.3 short name.
  display_name?: string;
  m_timestamp?: number;
  type?: string;
}

export interface ChildDto {
  name: string;
  display: string;
  path: string;
  origin: string;
  refs: RefsDto;
}

export interface RefsDto {
  // PrusaLink Web API `PrintFileRefs`: `icon` is the small (~16-24px)
  // thumbnail, `thumbnail` the big (~220px) one. Both may be null/absent
  // (e.g. plain .gcode sliced without thumbnails, or the legacy Einsy shim).
  icon?: string | null;
  thumbnail?: string | null;
  download: string;
}
