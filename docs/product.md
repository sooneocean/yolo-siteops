# MVP product contract

## User and outcome

The first user is a WordPress owner operating one site from a trusted local computer. SiteOps turns observed search demand into a reviewable editorial change, records the operation, and waits for a complete measurement window before reporting an outcome.

The primary loop is: connect → sync evidence → rank opportunities → generate one proposal → review → approve and apply → verify → observe → reflect on the editorial Skill.

## Evidence and audience

Search Console queries describe observed searches; they do not identify individual readers. GA4 landing-page engagement provides aggregate quality context when the measurement checks pass. Audience descriptions and related keyword suggestions remain hypotheses until supported by new evidence. SiteOps does not infer personal identities or treat suggested keywords as measured search volume.

Compare the latest 28 complete Search Console days with the preceding 28 days. Candidates need at least 100 impressions. They must also have average position 4–20, or at least 20 previous clicks and a 20% decline. Rank declining pages first. Group URL variants before selecting up to ten articles. Query coverage remains bounded and is shown with the snapshot.

## Operator controls

- One local operator and one WordPress site in this version.
- Each proposal pins its source snapshot and Skill version.
- Each production write requires a concrete human approval, fresh protected-state checks, a backup, a writer lock, and authenticated/public read-back.
- Rollback requires a separate approval and refuses to overwrite newer external edits.
- Uncertain writes stop for manual review and cannot be silently retried.
- Skill reflection produces a candidate; three fixed synthetic replays and manual activation precede use. Restore the baseline explicitly when needed.

## Recurring operation

Scheduling starts disabled. The optional local schedule checks demand daily at 09:00 Asia/Taipei and generates at most three weekly proposals on Monday at 09:30. The local process must remain running. Daily model-call limits include editorial tasks and Skill work. Catch up only the latest due run; record interrupted or failed runs without automatically retrying them. Scheduled work creates proposals and never approves a production write.

## Acceptance

The engineering acceptance covers a fresh install, checks, the complete synthetic browser journey, a real Codex turn, a disposable real WordPress apply/read-back/restore cycle, and the Skill lifecycle. Production acceptance adds a reviewed, explicitly approved single-article change with fresh read-back evidence. A successful run proves that recorded workflow, not whole-site optimization or improved business performance.

Post-change measurement starts on the next complete Search Console day and needs a full 28-day window. Missing evidence remains insufficient; later content edits confound the observation. No causal traffic, ranking, CTR, GEO, or ROI claim follows merely from publishing a proposal.
