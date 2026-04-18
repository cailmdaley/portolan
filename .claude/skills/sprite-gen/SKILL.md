---
name: sprite-gen
description: Generate city sprites for the portolan map via Antigravity (Google's VS Code fork with Gemini). Use when creating or iterating on city sprites, or when the user says "make a sprite", "new city sprite", "generate a sprite".
---

# Portolan Sprite Generation

Generate city sprites by driving Gemini image generation inside Antigravity via Electron automation (agent-browser), then extract transparency via difference matting.

## The Portolan Aesthetic

Sprites are Renaissance cartographic city plans on a warm vellum world. They float on transparency — the ink appears drawn directly on the parchment background.

**Projection:** oblique ~45° from horizontal (cavalier style), viewed from due south looking north. Show both rooftops AND south-facing walls in equal proportion.

**Ink palette:** sepia, red ochre, and verdigris/teal. No modern colors. Hand-inked linework.

**Edges are critical:** penwork must fade with CLEAN LINE THINNING — roads trail off as thinner and thinner lines, buildings become sketchy outlines that simply stop. NOT watercolor washes or soft gradients (those cause transparency artifacts). Sharp ink lines that thin out and end cleanly. The illustration floats in white space with organic but crisp trailing edges.

**No:** circular frames, ornamental borders, compass roses (we draw our own), paper textures (the vellum layer provides that), text labels.

**Size:** 512×512 pixels. Gemini may return 640×640 — fine.

Look at existing sprites in `public/sprites/cities/` for calibration.

## Prompting Philosophy

**Describe the project's soul, not just its function.** Let Gemini find the visual metaphor.

Wrong: "Draw an observatory with an armillary sphere, radial cloisters..."
Right: "This project is about separating truth from artifact. The pure E/B decomposition separates cosmological signal from noise. The work is methodical, precise, almost monastic..."

The first substitutes your visual imagination for Gemini's. The second gives Gemini the *meaning* and lets it find imagery you wouldn't have thought of.

**Push toward abstraction.** The best sprites blur concept and architecture — letterforms becoming buildings, money becoming rivers, data becoming towers. If the first generation is too literal (just a realistic neighborhood), push Gemini toward the abstract: "what does this *feel* like as a city?" A city made of language itself is more interesting than a city where people speak French.

**If including text in sprites:** Gemini will hallucinate fake words. Provide a curated list of real words it can use, and tell it that anything it's unsure of should be calligraphic flourish instead. Expect 1-2 iterations to get text right.

### Prompt Template

```
I'm creating sprites for a digital portolan map - the medieval Mediterranean
navigation charts with their warm vellum backgrounds, compass roses, and rhumb
lines. Each city on the map needs a small illustrated city plan that looks like
it was drawn by a Renaissance cartographer.

The sprite will be placed on a warm cream vellum texture (#f5eee1). The white
background will become transparent through difference matting, so the ink lines
will appear drawn directly on the parchment.

This city represents "[PROJECT NAME]" — [ONE-LINE DESCRIPTION].

[2-4 PARAGRAPHS DESCRIBING THE PROJECT]:
- What it does, what problem it solves
- Key concepts, metaphors, or themes
- The "feel" of working with it
- Any visual metaphors that come naturally

Create a portolan-style city that evokes this project. You decide the visual
metaphor — what kind of city captures its essence?

---

Technical: oblique ~45° projection, viewed from south. Sepia/red ochre/verdigris
ink on pure white #FFFFFF background.

CRITICAL for edges: The penwork must fade with CLEAN LINE THINNING — roads trail
off as thinner and thinner lines, buildings become sketchy outlines that simply
stop. NOT watercolor washes or soft gradients. Sharp ink lines that thin out and
end cleanly. The illustration should float in white space with organic but crisp
trailing edges.

No circular frame, no compass roses, no paper texture. 512x512, no text labels.
```

### Before prompting: read the project deeply

CLAUDE.md is a start, but go further: README, actual source, key documentation. The abstract and introduction of a paper reveal the project's soul better than technical setup notes. Write a rich description — let Gemini see the project's character.

### Previous sprites for reference

| City | Essence | Visual metaphor |
|------|---------|-----------------|
| felt | DAG-native task tracker, fibers interlock | Woven textile structure |
| life | Personal life in Palaiseau | Warm village with church |
| loom | Master tapestry, infrastructure | Weaving workshop with braided threads |
| email | "Inbox is a garden, not battlefield" | Postal sorting house with letter streams |
| portolan | This map app, meta/recursive | Cartographer's workshop drawing maps |
| pure_eb | E/B mode separation, alchemical distillation | Filtering towers, dual streams, crystalline purity |
| cmbx | CMB × Euclid cross-correlations, epochs in dialogue | Two districts (ancient/modern) bridged |
| arxiv | Daily arXiv reading, cosmological discovery | Observatory mind-palace: telescopes, armillary sphere, scroll stacks |
| french | French language class in France | Abstract: letterform buildings, cursive streets, accent-mark spires, real French words woven in |
| finances | Couple's personal finance tracking in Paris | Counting house with teal money-rivers, coin-stack towers, open ledger books |

## Automation Recipe

### 1. Launch Antigravity with CDP

```bash
# Check if already running with CDP
lsof -i :9333 | head -3

# If not, kill any existing instance and relaunch
pkill -f "Antigravity.app/Contents/MacOS/Electron"
sleep 2
open -a "Antigravity" --args --remote-debugging-port=9333
sleep 5
```

Port 9333 avoids collision with Slack (which often grabs 9222).

### 2. Connect agent-browser

```bash
agent-browser connect 9333
agent-browser tab          # Verify you see "Antigravity" target
```

If you see Slack or another app, the port was stolen. Kill and retry on a different port.

### 3. Find the chat input

```bash
agent-browser snapshot -i   # Look for: textbox [ref=eNN] and button "Send"
```

The Agent panel has a textbox and a Send button. Ref numbers change between sessions — always snapshot first.

### 4. Generate on white background

```bash
agent-browser fill @eNN "<prompt with white background instructions>"
agent-browser click @eSEND
sleep 30   # Generation takes 15-40s
```

**If `fill @eNN` fails with "matched 2 elements":** use JS to target the textbox directly:

```bash
agent-browser eval "const els = document.querySelectorAll('[role=\"textbox\"]'); els[els.length-1].focus(); document.execCommand('selectAll'); document.execCommand('delete'); document.execCommand('insertText', false, '<your prompt>')"
```

Then snapshot for the Send button ref and click it.

### 5. Extract the image URL

```bash
agent-browser eval "Array.from(document.querySelectorAll('img')).map(i => ({src: i.src?.substring(0, 300), alt: i.alt, w: i.naturalWidth})).filter(i => i.w > 100)"
```

The most recent large image is your generation. Download it:

```bash
curl -sk "<image-url>" -o /tmp/sprite-white.png
```

### 6. Verify

Use the Read tool on the PNG to visually verify. Check that edges fade organically, no hard borders, no baked-in paper texture.

### 7. Generate on black background (for matting)

**Try editing first:** re-snapshot for fresh refs, then:

```bash
agent-browser fill @eNN "Edit the previous image: Change the background to pure solid black #000000. Keep EVERYTHING else exactly identical — same city, same details, same colors. ONLY the background changes."
agent-browser click @eSEND
sleep 30
```

Download the same way as step 5 → `/tmp/sprite-black.png`.

Verify the background is actually black by checking corner pixels:

```bash
python3 -c "from PIL import Image; img=Image.open('/tmp/sprite-black.png').convert('RGB'); print(img.getpixel((0,0)), img.getpixel((0,img.height-1)))"
```

**If the edit fails** (background stays white — Gemini struggles with this on some compositions): reverse the approach. Regenerate the scene from scratch on black, describing the composition in detail. Then edit *that* to white. Black→white edits succeed more reliably than white→black.

**Critical: Gemini often tries to change backgrounds programmatically** (writing Python to swap pixels) instead of using its image generation tool. When this happens, the result has obvious artifacts. Be explicit: "Use your IMAGE GENERATION tool (not code, not Python, not programmatic editing) to GENERATE a new image." This phrasing reliably triggers actual generation.

**Bonus:** if the black-background version drifts slightly from the white and you prefer it, reverse the flow — use the black as the reference and ask Gemini to generate white from it. Either direction works for matting; you just need a matched pair.

### 8. Difference matting

```bash
python3 .claude/skills/sprite-gen/scripts/extract_alpha.py /tmp/sprite-white.png /tmp/sprite-black.png /tmp/sprite-final.png
```

Verify with Read tool. Trust the result — what looks like "visual noise" is usually trailing roads and incomplete outlines (good — organic edges).

### 9. Install

```bash
cp /tmp/sprite-final.png public/sprites/cities/<city-name>.png
```

## Iteration

Keep using the same Antigravity chat — Gemini maintains context. Re-snapshot for fresh refs each time. Iterate on meaning, not visual prescriptions: describe *what's missing* in terms of the project's character, not pixel-level corrections.

When satisfied with a version, run the white/black/matte pipeline on the final.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `agent-browser connect` fails | App not running with CDP. Kill and relaunch. |
| Wrong app on CDP port | Another Electron app stole it. Different port. |
| Send button disabled | Textbox empty. Re-snapshot and re-fill. |
| Image not in DOM query | Still generating. Wait longer, re-query. |
| `curl` returns HTML not PNG | CSRF token expired. Re-query DOM for fresh URL. |
| Matting noisy edges | Subject changed between white/black. Regenerate with stronger language. |
| Watercolor-wash edges | Re-prompt: "CLEAN LINE THINNING, not soft gradients." |
| White→black edit keeps failing | Reverse: regenerate on black from scratch, then edit to white. |
| Image gen quota hit | ~10 generations per rolling window. Wait ~1.5-4 hours for reset. |
| Need to find old artifacts | List the artifact dir: `curl -sk "https://127.0.0.1:PORT/static/artifacts/SESSION_ID/?csrf=TOKEN"` |
| Connection dropped after idle | `agent-browser connect 9333` to reconnect. Antigravity stays running. |
