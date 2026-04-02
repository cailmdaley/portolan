---
title: Stream raw binary media responses to avoid buffer spikes
status: closed
tags:
    - task
depends-on:
    - constitution-portolan
created-at: 2026-03-01T17:40:06.296694+01:00
closed-at: 2026-03-01T17:42:47.911093+01:00
outcome: 'Replaced buffered raw media response paths with streaming transport in server/src/HttpApi.ts: /file-content?raw=true and /tapestry-asset now stream local files via createReadStream and remote files via SSH stdout piping with timeout/backpressure/error handling, avoiding full-payload buffer allocation for large images/PDFs. Added regression coverage in server/src/__tests__/HttpApi.file-content.test.ts for raw binary bytes/headers, 404 behavior, and binary=true compatibility mode. Evidence: cd server && npm test (259 tests), cd server && npm run build, npm run build.'
---

(stream-raw-binary-media)=
Replace buffered raw media response paths with streaming for local/remote file serving in HttpApi so large image/PDF requests do not allocate full payload buffers.
