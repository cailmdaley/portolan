import { encodeUrlState } from './UrlFragment'

export interface VellumFileUrlArgs {
  baseUrl: string
  path: string
  cityId?: string
}

export function buildVellumFileUrl({ baseUrl, path, cityId }: VellumFileUrlArgs): string {
  const url = new URL(baseUrl)
  url.search = ''
  url.hash = encodeUrlState({
    cityId,
    mode: 'narrative',
    filePath: path,
  })
  return url.toString()
}
