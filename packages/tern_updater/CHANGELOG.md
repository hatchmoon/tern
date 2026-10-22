## 0.2.0

- Replace the Shorebird Dart dependency with Tern's original Android native runtime.
- Use official Flutter with authenticated AOT-library selection at startup.
- Verify signed patch context, SHA-256 and architecture before staging and launch.
- Confirm startup through the first rendered frame and recover on the next launch when startup fails.
- Preserve the banner, foreground checks, unsaved-work guard and confirmed cold restart.
- Requires Android API 26 and a new baseline APK; existing 0.1.0 releases retain their original runtime.

## 0.1.0

- Check and stage Tern patches on startup, foreground resume, and while in use.
- Expose running and next patch state, including rollback to the store release.
- Show a theme-aware Update ready banner with Later and confirmed Restart now.
- Restart Android using a non-exported activity in a separate process.
- Support an app-supplied guard for unsaved work and custom update UI.
