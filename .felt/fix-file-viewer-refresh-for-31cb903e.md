---
title: File viewer refresh fix
created-at: 2026-03-12T10:20:45.196724+01:00
outcome: refresh() used textEditor.getCurrentContent() which is null for PDFs/images — silently no-oped. Switched to contentPresenter.getCurrentPath(). Also added cache-busting (&_t=timestamp) on refresh so browser max-age=3600 doesn't serve stale content. Threaded cacheBust flag through ShowFileOptions → ContentPresenter → ContentLoader → buildRawFileUrl. Also fixed refresh losing cityPath/cityId for remote files.
---
