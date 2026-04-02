---
title: 'Gotcha: Gemini white→black edit fails'
tags:
    - gotcha
depends-on:
    - sprite-gen-skill-antigravity
created-at: 2026-03-02T11:09:28.54195+01:00
outcome: 'Gemini image edit to change white background to black frequently fails silently — returns the image with background still white, or inverts city colors. Workaround: regenerate the scene from scratch on black background (describing composition in detail), then edit that result to white. Black→white edits succeed reliably. Pixel-check corners to verify: python3 -c ''from PIL import Image; img=Image.open(path).convert("RGB"); print(img.getpixel((0,0)))'''
---

(gotcha-gemini-white-black-edit)=
# Gotcha: Gemini white→black edit fails
