# Fact conflict resolution

If a major external-research conflict affects a core conclusion, mechanism, key number/date, or recommendation, the harness stops at `awaiting_human_fact_resolution`.

Inspect the conflict report, then resolve each open conflict with exactly one decision:

```bash
pnpm --dir scripts/wechat wechat-agent resolve-facts <run-id> \
  --conflict <conflict-id> \
  --decision research_wins|retain_with_qualification|drop_claim \
  --note "optional decision context"
```

No render, upload, create-draft, or update-draft operation may proceed while a major conflict is open.
