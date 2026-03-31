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

  // Slide annotation fields (for reveal.js / HTML presentations)
  slide?: number               // 0-indexed slide number
  slideTitle?: string           // heading text from the slide
  isSlideAnnotation?: boolean
}
