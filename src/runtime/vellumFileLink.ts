import { encodeUrlState } from './UrlFragment'

export interface VellumFileUrlArgs {
  baseUrl: string
  path: string
  cityId?: string
  originId?: string
}

export function buildVellumFileUrl({ baseUrl, path, cityId, originId }: VellumFileUrlArgs): string {
  const url = new URL(baseUrl)
  url.search = ''
  url.hash = encodeUrlState({
    cityId,
    mode: 'narrative',
    filePath: path,
    originId,
  })
  return url.toString()
}
