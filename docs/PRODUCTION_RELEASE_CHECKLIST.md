# Production Release Checklist

This is the standard checklist to follow before every production release of Mantra Japam. Every section should be completed, in order, before promoting a change to production.

## 1. Code Preparation

- [ ] Feature branch clean (no stray/unrelated files, no debug code, no secrets)
- [ ] PR created
- [ ] Code review completed
- [ ] TypeScript clean (`npx tsc --noEmit`)
- [ ] Tests executed (`npm test`) — note any pre-existing/unrelated failures explicitly
- [ ] No unrelated changes in the diff
- [ ] Documentation updated if needed

## 2. GitHub

- [ ] Related Issue exists
- [ ] PR references Issue (e.g., `Closes #N`)
- [ ] PR approved
- [ ] Merge strategy documented (merge commit / squash / rebase)
- [ ] `main` updated and confirmed to match the intended source commit

## 3. Staging

- [ ] Publish preview OTA
- [ ] Record update ID
- [ ] Record commit
- [ ] Record runtimeVersion

## 4. Android Physical Device Validation

Every regression test below must be run against the staging build on a real device before proceeding to production.

### Timer

- [ ] Foreground session
- [ ] Background session
- [ ] Pause/resume
- [ ] Native completion
- [ ] Final loop
- [ ] Multiple malas
- [ ] Force close
- [ ] Reopen
- [ ] Duplicate completion
- [ ] History persistence
- [ ] Main/History counts
- [ ] Notification
- [ ] Sound
- [ ] Vibration

### History

- [ ] Add
- [ ] Edit
- [ ] Delete
- [ ] Totals

### Google Sign In

- [ ] Sign in
- [ ] Sign out
- [ ] Sync

### Groups

- [ ] Create
- [ ] Join
- [ ] Dashboard
- [ ] Counts

## 5. Web Validation

- [ ] Production build works
- [ ] Login
- [ ] History
- [ ] Timer
- [ ] Legal pages
- [ ] Responsive layout

## 6. Production Release

- [ ] Merge to `main`
- [ ] Publish Android OTA
- [ ] Deploy web
- [ ] No DB migrations unless intentional
- [ ] No native builds unless required

## 7. Verification

Record the following for every production release:

- Commit hash:
- OTA update ID:
- Update group:
- runtimeVersion:
- Web deployment URL:
- Deployment time:

## 8. Post Release

- [ ] Create release notes
- [ ] Update GitHub Issues
- [ ] Link PRs
- [ ] Close milestones
- [ ] Document regressions if found

## Lessons Learned

- **Keep `main` aligned with production.** Deployed code that lives only on local/unmerged branches causes `main` to drift silently, and every subsequent PR against it shows a huge, unrelated diff instead of the intended change.
- **Always test staging before production.** Staging OTA validation is what catches regressions (including subtle races) before they reach real users — never skip straight to a production publish.
- **Validate on a real Android device.** Simulators and log inspection alone are not sufficient — native/background timer behavior, OTA channel matching, and completion races only surface reliably on physical hardware.
- **Race conditions require repeated testing.** A single clean pass does not prove a race-condition fix — timing-sensitive bugs need multiple repro attempts, deliberately timed around the vulnerable window, before being trusted.
- **Verify OTA channel/runtimeVersion.** A device can only receive updates published to the channel baked into its native build at build time. Before concluding an OTA "did not arrive," confirm channel, branch, and `runtimeVersion` via `eas channel:view` / `eas update:list` — this has repeatedly been the actual explanation for an update appearing "missing."
- **Use GitHub Issues as a knowledge base.** Recording resolved bugs (symptom, root cause, fix, validation, prevention) turns past incidents into a searchable reference instead of relying on memory or scattered docs.
- **Keep PRs small and focused.** A PR that bundles an unrelated refactor with a targeted fix is harder to review and harder to safely revert — prefer the smallest change that solves the specific problem.
