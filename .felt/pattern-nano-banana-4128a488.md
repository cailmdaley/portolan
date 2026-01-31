---
title: 'Pattern: nano-banana transparency extraction'
status: closed
kind: spec
priority: 2
created-at: 2026-01-31T23:26:17.444202+01:00
closed-at: 2026-01-31T23:26:17.444207+01:00
close-reason: 'Difference matting (white bg + black bg → alpha extraction) doesn''t work reliably with nano-banana/Gemini because the AI subtly changes the asset when editing the background, breaking the math. Simple approach works better: generate on pure white, then use ImageMagick fuzz-based removal: ''magick input.png -fuzz 5% -transparent white output.png''. For sprites, this produces clean results without the complexity of two-image workflows.'
---
