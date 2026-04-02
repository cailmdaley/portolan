---
title: 'File viewer enhancements: Edit diffs + image preview'
status: closed
depends-on:
    - worker-activity-panel-activity
created-at: 2026-01-20T21:35:51.444169+01:00
closed-at: 2026-01-20T21:39:01.462307+01:00
---

(file-viewer-enhancements-edit)=
# File Viewer Enhancements

Two additions to the file viewer modal:

## 1. Edit Tool Diffs

When viewing an Edit activity, show the diff instead of full file contents:
- Display old_string → new_string as a unified diff
- Red for removed lines, green for added
- Context lines around the change
- The Edit tool captures `old_string` and `new_string` in toolInput

**Data flow:**
- Server already has `toolInput` with `{ old_string, new_string, file_path }`
- Modal detects tool === 'Edit' and renders diff view
- Use simple inline diff rendering (no library needed for old→new)

## 2. Image Preview

When the file is an image (png, jpg, gif, svg, webp):
- Display the image instead of code
- Scale to fit modal (max-width/max-height with object-fit)
- Show filename and dimensions if available

**Detection:**
- Check file extension from fullPath
- Image extensions: .png, .jpg, .jpeg, .gif, .svg, .webp, .ico

**Data flow:**
- GET /file-content returns `{ type: 'image', url: '/files/...' }` for images
- Or encode small images as base64 data URLs
- Modal renders `<img>` instead of `<pre>`

## Completion

- Edit activities show diff with red/green highlighting
- Image files display as images in the modal
- Both work for local and remote files
