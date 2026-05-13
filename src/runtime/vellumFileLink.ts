import { encodeUrlState } from './UrlFragment'

export interface VellumFileUrlArgs {
  baseUrl: string
  path: string
  cityId?: string
  originId?: string
}

export interface VellumFiberUrlArgs {
  baseUrl: string
  slug: string
  cityId?: string
}

function buildVellumUrl(
  baseUrl: string,
  state: Parameters<typeof encodeUrlState>[0],
): string {
  const url = new URL(baseUrl)
  url.search = ''
  url.hash = encodeUrlState(state)
  return url.toString()
}

export function buildVellumFileUrl({ baseUrl, path, cityId, originId }: VellumFileUrlArgs): string {
  return buildVellumUrl(baseUrl, {
    cityId,
    mode: 'narrative',
    filePath: path,
    originId,
  })
}

export function buildVellumFiberUrl({ baseUrl, slug, cityId }: VellumFiberUrlArgs): string {
  return buildVellumUrl(baseUrl, {
    cityId,
    mode: 'narrative',
    fiberSlug: slug,
  })
}
