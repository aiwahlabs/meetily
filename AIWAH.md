# Aiwah Minutes: fork notes

This repository is Aiwah Labs' fork of
[Zackriya-Solutions/meetily](https://github.com/Zackriya-Solutions/meetily) (MIT).
It ships **Aiwah Minutes**, a desktop meeting recorder. Every meeting it records
is synced to **HQ Workshop → Meetings**.

- HQ project: "Aiwah Minutes Desktop (Meetily fork)" (`cmwndwtnt00j09t01kncm9dz8`)
- Targets: Windows x64 (`.exe`, NSIS) and Apple Silicon macOS (`.dmg`)

## Branches and upstream sync

| Branch | Purpose |
|---|---|
| `main` | The Aiwah product branch. It is always buildable. |
| `aiwah/<topic>` | Feature work. Merge into `main` through a PR on this fork. |
| `upstream/main` | Zackriya's branch. Read only. |

To pull in upstream changes, about once a month or when a fix we need lands:

```bash
git fetch upstream
git checkout -b aiwah/upstream-sync-YYYY-MM main
git merge upstream/main        # resolve conflicts, keeping Aiwah behaviour
# run the Aiwah build workflow, then open a PR into main
```

Rules that keep merges cheap:

1. **Isolate Aiwah code in modules.** Put Rust in `frontend/src-tauri/src/hq/` and the
   React UI in `frontend/src/components/hq/`. In upstream files, add only small
   hook calls (`// AIWAH:` comment), not rewrites.
2. **Keep upstream workflow files.** Our CI is `.github/workflows/aiwah-build.yml`.
3. **Don't rename storage keys, DB names or legacy-import strings.** Branding covers
   only user-visible text, icons and `tauri.conf.json`.
4. **Never open PRs or issues upstream** from Aiwah work unless someone decides to.

## Building

Run **Actions → "Aiwah Minutes - Build (Windows + Apple Silicon)" → Run workflow**.
Leave `sign-build` off. The run uploads the installers as workflow artifacts.

The build passes `src-tauri/tauri.aiwah-noupdater.conf.json` to turn off updater
artifacts until the fork has its own updater signing key (the
`TAURI_SIGNING_PRIVATE_KEY` secret). Code signing and notarisation are tracked in
the HQ project; for now, the builds are unsigned:

- **macOS:** right-click the app → Open on first launch, or run
  `xattr -dr com.apple.quarantine "/Applications/Aiwah Minutes.app"`.
- **Windows:** SmartScreen → More info → Run anyway.

## HQ integration (overview)

- **English meetings:** transcribed locally. After the meeting is saved, the app posts
  the transcript to `POST {HQ}/v1/meetings/ingest`.
- **Indic meetings** (Malayalam, Tamil, Hindi and others): the recording is uploaded to HQ.
  HQ transcribes it with Sarvam (company key, server-side) and writes the
  transcript, summary and action items into the meeting.
- **Credentials:** each user pastes their own HQ API key in Settings → HQ.
  The key never leaves the device except in requests to HQ.
