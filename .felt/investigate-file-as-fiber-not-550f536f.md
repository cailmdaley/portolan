---
title: 'Investigate: File as Fiber not working for remote images'
status: open
kind: question
priority: 2
depends-on:
    - feature-file-as-fiber-button-in-fccaddd6
created-at: 2026-01-25T15:22:23.964679+01:00
---

User tried filing fiber from PNG on pure_eb (remote), didn't appear in fibers. API endpoint test shows it works - created fiber successfully via curl.

Issue likely in frontend:
- originId not being passed correctly for remote cities?
- JavaScript error swallowing the failure?
- Check browser console when clicking 'File as Fiber' on remote

Test command that worked:
curl -X POST http://localhost:4004/file-as-fiber -H 'Content-Type: application/json' -d '{"filePath": "/path/test.png", "originId": "remote-c02", "title": "Test", "body": "test", "kind": "task"}'
