# Tern native Android example

Run from the Tern repository while its server and an Android emulator are running:

```powershell
npm run cli -- setup
npm run demo:android
```

The verifier installs this sample once, delivers and executes a changed Dart UI through Tern, and tests rollback. It clears only this dedicated demo app's data. Reports, app logs, and screenshots go to `test-results/android/`.

See [Android quickstart](../../docs/ANDROID.md) for configuration and supported scope. Runtime YAML and the application ID are generated locally.
