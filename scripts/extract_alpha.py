#!/usr/bin/env python3
"""Extract alpha channel using difference matting (white - black backgrounds)"""
import sys
from PIL import Image
import numpy as np

def extract_alpha(white_path, black_path, output_path):
    white = np.array(Image.open(white_path).convert('RGB')).astype(float)
    black = np.array(Image.open(black_path).convert('RGB')).astype(float)
    
    # alpha = 1 - (white - black) / 255
    alpha = 1.0 - (white - black) / 255.0
    alpha = np.clip(alpha.mean(axis=2), 0, 1)  # Average across RGB channels
    
    # color = black / alpha (avoid division by zero)
    with np.errstate(divide='ignore', invalid='ignore'):
        color = np.where(alpha[..., np.newaxis] > 0.01, 
                        black / alpha[..., np.newaxis], 
                        0)
    color = np.clip(color, 0, 255).astype(np.uint8)
    
    # Combine into RGBA
    result = np.dstack([color, (alpha * 255).astype(np.uint8)])
    Image.fromarray(result, 'RGBA').save(output_path)
    print(f"Saved: {output_path}")

if __name__ == '__main__':
    if len(sys.argv) != 4:
        print("Usage: extract_alpha.py white.png black.png output.png")
        sys.exit(1)
    extract_alpha(sys.argv[1], sys.argv[2], sys.argv[3])
