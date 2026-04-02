---
title: Slide annotations for reveal.js
tags:
    - portolan
depends-on:
    - preserve-reveal-js-slide-hash
    - file-annotations-in
created-at: 2026-03-23T10:00:05.268986+01:00
outcome: 'Per-slide annotations on reveal.js presentations viewed in the file viewer. Bridge injects reveal.js slide-change listener that posts slideIndex, slideTitle, totalSlides via postMessage. Content loader tracks slide state; annotation panel shows ''+ Slide'' button when slides detected. Clicking immediately persists a stub annotation tagged with slide number and title, then opens inline edit. Annotations survive slide navigation (persistent, not ephemeral). Panel preview shows ''S3: Title'', goto navigates iframe to that slide. Transport formats as ''Slide N: Title'' when sending to workers.'
---

(slide-annotations-for-reveal-js)=
# Slide annotations for reveal.js
