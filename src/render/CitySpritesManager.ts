// CitySpritesManager.ts - Manages city sprite loading, caching, and generation
// Cities are represented by nano-banana generated circular city plan sprites

import { Texture, TextureLoader } from 'three'
import type { City } from '../state/types'

// Number of default fallback sprites
const NUM_DEFAULT_SPRITES = 5

export class CitySpritesManager {
  private textureLoader = new TextureLoader()
  private spriteCache: Map<string, Texture> = new Map()
  private defaultSprites: Map<number, Texture> = new Map()
  private pendingGenerations: Set<string> = new Set()
  private pendingLoads: Set<string> = new Set()  // Track in-flight loads
  private failedLoads: Set<string> = new Set()   // Track failed loads (use default)
  private defaultSpritesLoaded = false

  constructor() {
    this.loadDefaultSprites()
  }

  /**
   * Load the 5 default city sprites from public/sprites/cities/
   */
  private loadDefaultSprites(): void {
    for (let i = 1; i <= NUM_DEFAULT_SPRITES; i++) {
      // Sprites served from public/sprites/cities/
      const path = `/sprites/cities/default-${i}.png`
      this.textureLoader.load(
        path,
        (texture) => {
          this.defaultSprites.set(i, texture)
          if (this.defaultSprites.size === NUM_DEFAULT_SPRITES) {
            this.defaultSpritesLoaded = true
          }
        },
        undefined,
        (error) => {
          console.warn(`Failed to load default sprite ${i}:`, error)
        }
      )
    }
  }

  /**
   * Get a deterministic default sprite index based on city ID
   * Uses simple hash to ensure same city always gets same default
   */
  private getDefaultSpriteIndex(cityId: string): number {
    let hash = 0
    for (let i = 0; i < cityId.length; i++) {
      hash = ((hash << 5) - hash) + cityId.charCodeAt(i)
      hash = hash & hash // Convert to 32-bit integer
    }
    return (Math.abs(hash) % NUM_DEFAULT_SPRITES) + 1
  }

  /**
   * Get sprite texture for a city
   * Tries to load custom sprite by city name, falls back to default
   */
  getSprite(city: City): Texture | null {
    // Check for city-specific cached sprite
    const cached = this.spriteCache.get(city.id)
    if (cached) {
      return cached
    }

    // If we already tried and failed to load this city's sprite, use default
    if (this.failedLoads.has(city.id)) {
      return this.getDefaultSprite(city.id)
    }

    // Try to load custom sprite by city name (if not already loading)
    if (!this.pendingLoads.has(city.id)) {
      this.loadCitySprite(city)
    }

    // While loading, return default
    return this.getDefaultSprite(city.id)
  }

  /**
   * Try to load a custom sprite for a city by name
   */
  private loadCitySprite(city: City): void {
    this.pendingLoads.add(city.id)
    const path = `/sprites/cities/${city.name}.png`

    this.textureLoader.load(
      path,
      (texture) => {
        this.spriteCache.set(city.id, texture)
        this.pendingLoads.delete(city.id)
      },
      undefined,
      () => {
        // Failed to load - mark so we don't retry
        this.failedLoads.add(city.id)
        this.pendingLoads.delete(city.id)
      }
    )
  }

  /**
   * Get a default sprite based on city ID (deterministic selection)
   */
  getDefaultSprite(cityId: string): Texture | null {
    const index = this.getDefaultSpriteIndex(cityId)
    return this.defaultSprites.get(index) || null
  }

  /**
   * Check if a city sprite is being generated
   */
  isGenerating(cityId: string): boolean {
    return this.pendingGenerations.has(cityId)
  }

  /**
   * Check if default sprites have loaded
   */
  hasDefaults(): boolean {
    return this.defaultSpritesLoaded
  }

  /**
   * Trigger async sprite generation for a city
   * This would call the server endpoint to generate via nano-banana
   * For now, just marks as pending - actual generation TBD
   */
  async generateSprite(city: City): Promise<void> {
    if (this.pendingGenerations.has(city.id)) {
      return // Already generating
    }

    if (this.spriteCache.has(city.id)) {
      return // Already have it
    }

    this.pendingGenerations.add(city.id)

    try {
      // TODO: Call server endpoint to generate sprite
      // const response = await fetch(`/api/city-sprite?cityId=${city.id}`)
      // const data = await response.json()
      // Load the generated texture...

      // For now, just use default (generation not implemented yet)
      console.log(`Would generate sprite for city: ${city.name} (${city.id})`)
    } catch (error) {
      console.error(`Failed to generate sprite for ${city.id}:`, error)
    } finally {
      this.pendingGenerations.delete(city.id)
    }
  }

  /**
   * Manually set a cached sprite (e.g., after loading from disk)
   */
  setCachedSprite(cityId: string, texture: Texture): void {
    this.spriteCache.set(cityId, texture)
  }

  /**
   * Clear cache for a city (e.g., to force regeneration)
   */
  clearCache(cityId: string): void {
    this.spriteCache.delete(cityId)
  }

  /**
   * Dispose all textures
   */
  dispose(): void {
    for (const texture of this.spriteCache.values()) {
      texture.dispose()
    }
    for (const texture of this.defaultSprites.values()) {
      texture.dispose()
    }
    this.spriteCache.clear()
    this.defaultSprites.clear()
  }
}
