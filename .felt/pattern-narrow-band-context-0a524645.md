---
title: 'Pattern: narrow-band context more effective for Gemini outpainting'
status: closed
kind: spec
priority: 2
created-at: 2026-01-22T11:54:10.205533+01:00
closed-at: 2026-01-22T11:54:24.516224+01:00
close-reason: 'When asking Gemini to fill/outpaint, giving narrow edge context (512px strip) works better than giving half the image (2048px). For corner infill: show just the two adjacent edges that need connecting, not the full L-shaped region. Gemini matches edges more precisely with less context to get confused by.'
---
