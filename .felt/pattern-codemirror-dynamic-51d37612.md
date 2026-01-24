---
title: 'Pattern: CodeMirror dynamic decorations via StateField + StateEffect'
status: closed
kind: spec
priority: 2
created-at: 2026-01-23T23:39:28.192298+01:00
closed-at: 2026-01-23T23:39:28.192298+01:00
close-reason: |-
    To add dynamic highlights to CodeMirror (e.g., annotation markers):

    1. Define a StateEffect: `const setAnnotationsEffect = StateEffect.define<Annotation[]>()`
    2. Define a StateField that responds to the effect:
       ```typescript
       const annotationHighlightField = StateField.define<DecorationSet>({
         create() { return Decoration.none },
         update(decorations, tr) {
           decorations = decorations.map(tr.changes)
           for (const e of tr.effects) {
             if (e.is(setAnnotationsEffect)) {
               // Rebuild decorations from e.value
               decorations = Decoration.set(marks.map(m => annotationMark.range(m.from, m.to)))
             }
           }
           return decorations
         },
         provide: f => EditorView.decorations.from(f),
       })
       ```
    3. Add field to editor extensions: `annotationHighlightField`
    4. Dispatch effect to update: `editorView.dispatch({ effects: setAnnotationsEffect.of(annotations) })`

    Key: The StateField persists across transactions and maps positions through document changes.
---
