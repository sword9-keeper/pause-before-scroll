# Product Direction: ALL FOR HUMAN

## Objective

Build an easy-to-use, widely useful extension that genuinely reduces unwanted
entertainment browsing. Popularity is a desired outcome, not a claim that can be
established by shipping features or passing automated tests.

## Non-Negotiables

- The user chooses the sites, interventions, and stopping point.
- No shame, streak pressure, artificial rewards, hidden lockouts, or attention ads.
- Intentional recreation is legitimate. Do not label all entertainment as failure.
- Never turn declined attempts or planned minutes into invented "time saved".
- Report measured foreground visibility separately from visit elapsed time.
  Visibility is not proof that someone watched, read, or paid attention.
- Local-first use must remain useful offline. Sync and research participation
  are opt-in. A private preconfigured build is distinct from a public release.
- Preserve user data, explain destructive actions, and keep a recovery path.

## Full Product Requirements

1. A first-time user can install, choose their distracting sites and preferred
   intervention, and complete a successful first use without developer knowledge.
2. Support user-selected sites, including custom domains and precise exceptions,
   with minimum required permissions and clear local permission status.
3. Interrupt automatic opening without trapping the user. Make a deliberate
   short visit easy, and recognize repeated re-entry without shaming.
4. Make stopping ergonomic during a visit and at its end. Avoid surprising data
   loss from closing pages. Preserve intentional browsing and emergency access.
5. Provide honest, understandable personal evidence: foreground exposure,
   deliberate decisions, repeated returns, and measurement limitations.
6. Demonstrate a meaningful reduction in unwanted use through a consent-based
   pilot. Distinguish correlation, measurement changes, and causal evidence.
   Passing tests alone cannot satisfy this requirement.
7. Deliver polished, keyboard-accessible, reduced-motion-compatible UI, with
   Windows and macOS Chrome validation, localization and readable narrow layouts.
8. Make installation and updating straightforward through public distribution.
   Complete privacy documentation, assets, permission review, support information,
   and release checks. Keep private credentials out of public artifacts and Git.
9. Maintain a versioned, tested codebase and a viable feedback/iteration loop.

## Roadmap and Evidence

| Workstream | Status | Evidence Required |
| --- | --- | --- |
| Recoverable sync baseline | Complete | Local commit 5e87282; unit, sync, upgrade and personal-build tests |
| Honest foreground observations | Implemented and technically verified | Unit invariants, sleep-gap and worker-recovery checks; real Chromium focus/background checks; sync preservation |
| Intentional early exit | Implemented and technically verified | Browser stop/cancel/confirm checks; unit stale-document, unrelated-tab and shared-grant checks |
| Understandable personal overview | Implemented and technically verified | Unit day aggregation and legacy-unknown checks; real Chromium 1280/390/320 px screenshots; macOS user validation pending |
| First-run setup and custom sites | Implemented and technically verified | Fresh-profile first setup, narrow host grants, exact/path exceptions, SPA, permission-release preservation, independent-device authorization, and 1280/390/320 px checks; real permission-dialog, real-site and macOS validation pending |
| Humane end-of-visit flow | Implemented and technically verified | Chromium draft/document preservation, media pause, fullscreen exit, keyboard/narrow layouts; unit race/mute/recovery checks; real-site and macOS validation pending |
| Opt-in efficacy pilot | Not started | Protocol, consenting users, baseline/intervention data, dropout and adverse effects |
| Public distribution | Not started | Store-ready artifact, privacy policy, signed-off listing, real macOS check |
| Adoption and sustained value | Unproven | Real activation, retention, feedback, reduced unwanted use, not downloads alone |

## Measurement and Pilot Gate

The current visit timer measures elapsed wall-clock time, including background
tabs. It must not serve as a proxy for attention or time saved.

Version 0.5.0 records short, verified foreground intervals only. Long unobserved
gaps, old records, and sleep must not be filled with guessed minutes. Worker
restarts restore the last session snapshot; browser crashes can lose the
uncheckpointed tail. Comparisons between old and new measurement methods are
invalid.

Before claiming efficacy, agree a pilot protocol with participants: their own
target sites, what constitutes unwanted use, a baseline measured in the same
way, an intervention period, and periodic low-burden self-report. Report
within-person variation, attrition, disabling the extension, and displacement
to other sites/devices. Randomize or counterbalance intervention timing where
feasible. Do not collect browsing URLs or infer a clinical diagnosis.

Scientific research on digital self-regulation can inform hypotheses, but it
does not establish that this particular implementation works. Source findings
and limitations must be verified before being used in public claims.

## Completion Gate

The goal remains active until the full requirements above have direct evidence.
Implementation milestones, attractive screenshots, or a green test suite are
progress, not substitutes for measured user value and usable distribution.
