---
title: 'Ralph: Browser test File as Fiber + UI polish'
status: closed
depends-on:
    - investigate-file-as-fiber-not
created-at: 2026-01-25T15:45:59.556935+01:00
closed-at: 2026-01-25T16:19:00.022251+01:00
---

(ralph-browser-test-file-as)=
# Ralph: Browser Test File as Fiber

Test the "File as Fiber" feature via Chrome automation, fix bugs, and improve UI aesthetics.

## Rhythm

Each iteration:
1. **Invoke `/frontend-design`** — get fresh eyes on UI quality
2. **Browser test** — use Chrome extension to interact with hexarchy
3. **Fix/improve** — address bugs or UX issues found
4. **Mine** — `/mine` to extract learnings
5. **Exit** — `kill $PPID`

## The Bug

"File as Fiber" button doesn't work on remote images. API works (curl tested), frontend likely broken:
- originId not passed correctly for remote cities?
- JS error swallowed?
- Check browser console when clicking

## Test Plan

1. Open hexarchy at localhost:5173
2. Click a city with a remote worker (or local if no remote available)
3. Search for a file, open FileViewerModal
4. Add an annotation or global comment
5. Click "File as Fiber" button
6. Check: Does fiber get created? Browser console errors?
7. For remote: verify originId flows through correctly

## UI Polish Considerations

While testing, evaluate with frontend-design sensibility:
- Is the "File as Fiber" button discoverable?
- Does it communicate what it does?
- Visual hierarchy: is it clear what actions are available?
- Feedback: does user know when fiber was created?
- Error states: what happens if it fails?

## Completion

- File as Fiber works for both local and remote files
- UI is polished and discoverable
- No console errors
- User gets clear feedback on success/failure

## Comments
**2026-01-25 15:48** — **Iteration 1:** Fixed root cause — showImage/showPdf set currentContent=null, causing fileAsFiber() to bail. Added currentPath property, always set in show(). Build+tests pass. Chrome extension not connected, can't browser-test.
