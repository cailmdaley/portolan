export interface Annotation {
  id: string
  filePath: string
  originId: string
  from: number
  to: number
  line?: number
  endLine?: number
  originalText: string
  contextBefore: string
  contextAfter: string
  comment: string
  createdAt: number
  x?: number
  y?: number
  isImageAnnotation?: boolean
}
