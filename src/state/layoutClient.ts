// layoutClient.ts - HTTP client for per-city pin positions.
// See fiber `tapestry-dissolves`. Backend: server/src/HttpApiLayouts.ts.

export interface PinPosition {
  x: number
  z: number
}

/** See [[pin-any-file-type]]. Absent on legacy fiber-slug pins. */
export type PinKind = 'fiber' | 'markdown' | 'pdf' | 'image' | 'html' | 'other'

/** File-handle source: project-relative path + originId, OR an absolute URL. */
export type PinSource =
  | { originId: string; path: string; url?: undefined }
  | { url: string; originId?: undefined; path?: undefined }

export interface Pin extends PinPosition {
  slug: string
  pinnedAt: number
  /** Optional content classification (drives renderer dispatch). */
  kind?: PinKind
  /** Optional source handle. Absent = legacy fiber-slug pin. */
  source?: PinSource
  /** Optional intrinsic CSS-pixel width/height for DOM pins; per-card size that
   *  persists through the layout store. See [[file-view-as-floating-card]]. */
  width?: number
  height?: number
}

interface ListResponse {
  cityId: string
  pins: Pin[]
}

interface PinResponse {
  pin: Pin
}

const enc = encodeURIComponent

const API_BASE = `http://${typeof window !== 'undefined' ? window.location.hostname : 'localhost'}:4004`

export async function listPins(cityId: string): Promise<Pin[]> {
  const res = await fetch(`${API_BASE}/layouts/${enc(cityId)}`)
  if (!res.ok) throw new Error(`listPins ${cityId}: ${res.status}`)
  const body = (await res.json()) as ListResponse
  return body.pins ?? []
}

export async function putPin(
  cityId: string,
  slug: string,
  pos: PinPosition,
  extras?: { kind?: PinKind; source?: PinSource; width?: number; height?: number },
): Promise<Pin> {
  const res = await fetch(`${API_BASE}/layouts/${enc(cityId)}/pins/${enc(slug)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...pos, ...(extras ?? {}) }),
  })
  if (!res.ok) throw new Error(`putPin ${cityId}/${slug}: ${res.status}`)
  const body = (await res.json()) as PinResponse
  return body.pin
}

/**
 * Pin an arbitrary file (or URL). Server derives a stable slug from `source`,
 * so re-pinning the same file is idempotent. Returns the resulting pin
 * (including its derived slug). See [[pin-any-file-type]].
 */
export async function pinFile(
  cityId: string,
  pos: PinPosition,
  source: PinSource,
  kind?: PinKind,
): Promise<Pin> {
  const res = await fetch(`${API_BASE}/layouts/${enc(cityId)}/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...pos, source, ...(kind ? { kind } : {}) }),
  })
  if (!res.ok) throw new Error(`pinFile ${cityId}: ${res.status}`)
  const body = (await res.json()) as PinResponse
  return body.pin
}

export async function deletePin(cityId: string, slug: string): Promise<boolean> {
  const res = await fetch(`${API_BASE}/layouts/${enc(cityId)}/pins/${enc(slug)}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error(`deletePin ${cityId}/${slug}: ${res.status}`)
  const body = (await res.json()) as { removed: boolean }
  return body.removed
}
