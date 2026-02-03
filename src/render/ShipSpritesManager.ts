// ShipSpritesManager.ts - Manages ship sprites for workers

import { Texture, TextureLoader } from 'three'

export class ShipSpritesManager {
  private textureLoader = new TextureLoader()
  private shipTexture: Texture | null = null
  private loading = false
  private loaded = false

  constructor() {
    this.loadShipSprite()
  }

  private loadShipSprite(): void {
    if (this.loading || this.loaded) return
    this.loading = true

    this.textureLoader.load(
      '/sprites/ships/ship-1.png',
      (texture) => {
        // Mark as managed so disposeObject() won't dispose shared texture
        texture.userData = { managed: true }
        this.shipTexture = texture
        this.loaded = true
        this.loading = false
      },
      undefined,
      (error) => {
        console.warn('Failed to load ship sprite:', error)
        this.loading = false
      }
    )
  }

  getShipTexture(): Texture | null {
    return this.shipTexture
  }

  isLoaded(): boolean {
    return this.loaded
  }

  dispose(): void {
    if (this.shipTexture) {
      this.shipTexture.dispose()
      this.shipTexture = null
    }
  }
}
