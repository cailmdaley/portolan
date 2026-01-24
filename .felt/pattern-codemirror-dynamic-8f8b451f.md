---
title: 'Pattern: CodeMirror dynamic decorations via StateField + StateEffect'
status: closed
kind: spec
priority: 2
created-at: 2026-01-23T23:55:08.163951+01:00
closed-at: 2026-01-23T23:55:08.163952+01:00
close-reason: |-
    To add dynamic highlights to CodeMirror (e.g., annotation markers):

    1. Define a StateEffect: `const setAnnotationsEffect = StateEffect.define<Annotation[]>()`
    2. Define a StateField that:
       - Creates empty Decoration.none initially
       - In update(), maps decorations through changes, then checks for effect
       - Provides decorations via `provide: f => EditorView.decorations.from(f)`
    3. Add field to extensions array when creating EditorState
    4. Dispatch effect to update: `view.dispatch({ effects: setAnnotationsEffect.of(annotations) })`

    Example in FileViewerModal.ts:145-177. The StateField transforms annotation data into Decoration.set() with mark ranges.
---
