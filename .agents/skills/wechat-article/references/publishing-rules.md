# Publishing rules

- The CLI and deterministic renderer own production HTML; do not hand-author HTML or CSS.
- The article directory must contain the complete H2/H3 outline. Titles have no leading bullet; numbering is natural, never `01` or `01.1`.
- Code fences must render as dark code cards. Images must fit a 390px mobile screenshot.
- A dedicated cover, successful deterministic QA, successful independent QA, unchanged working-copy hash, and WeChat preflight are required before any draft mutation.
- Body images are uploaded and rewritten to remote URLs in `publish/article.md`; do not publish local file paths.
- Create and update are separate actions. Updating always requires an explicit `media_id`.
