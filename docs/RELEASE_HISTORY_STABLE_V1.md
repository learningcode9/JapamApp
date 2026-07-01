# release-history-stable-v1

**Date:** 2026-07-01
**Commit:** `d5a00946fe9d11ea2bc7da7ed264bb93f10450d8`
**Git tag:** `release-history-stable-v1`

## Android OTA

| Field | Value |
|---|---|
| Update ID | `019f1e93-ea31-7f21-aae5-74c7caf931fd` |
| Update Group ID | `f0bd5aea-9385-4263-9e0a-278ef01141a3` |
| Runtime Version | `1.0.0` |
| Branch / Channel | `production` / `production` |
| Platform | Android only |

## Verified features

- ✅ History restore
- ✅ UUID migration complete
- ✅ Production history restored
- ✅ Pencil edit works correctly
- ✅ Android History layout verified
- ✅ Web production verified
- ✅ Android OTA verified

## Known remaining work

- Today's count investigation
- Groups restore
- Future cleanup of temporary diagnostic log (`[LOCAL_FIX_BUILD_MARKER]`, currently shipped in this build — inert, no functional effect, but should be removed in a future pass)

## Rollback note

If any future release causes history regressions, compare against `release-history-stable-v1` first before investigating newer code.
