// layoutClient.ts - HTTP client for per-city pin positions.
// See fiber `tapestry-dissolves`. Backend: server/src/HttpApiLayouts.ts.

export interface PinPosition {
  x: number
  z: number
}

export interface Pin extends PinPosition {
  slug: string
  pinnedAt: number
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

export async function putPin(cityId: string, slug: string, pos: PinPosition): Promise<Pin> {
  const res = await fetch(`${API_BASE}/layouts/${enc(cityId)}/pins/${enc(slug)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(pos),
  })
  if (!res.ok) throw new Error(`putPin ${cityId}/${slug}: ${res.status}`)
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
