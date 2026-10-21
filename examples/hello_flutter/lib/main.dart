import 'package:flutter/material.dart';
import 'package:shorebird_code_push/shorebird_code_push.dart';

const variant = String.fromEnvironment(
  'TERN_DEMO_VARIANT',
  defaultValue: 'baseline',
);
const patched = variant == 'patched';
void main() => runApp(const TernExample());

class TernExample extends StatelessWidget {
  const TernExample({super.key});
  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'Tern runtime example',
    debugShowCheckedModeBanner: false,
    theme: ThemeData(
      colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xff3461e8)),
      scaffoldBackgroundColor: const Color(0xfff6f8fc),
      useMaterial3: true,
    ),
    home: const RuntimeScreen(),
  );
}

class RuntimeScreen extends StatefulWidget {
  const RuntimeScreen({super.key});
  @override
  State<RuntimeScreen> createState() => _RuntimeScreenState();
}

class _RuntimeScreenState extends State<RuntimeScreen> {
  final updater = ShorebirdUpdater();
  int? currentPatch;
  int? nextPatch;
  bool busy = false;
  String message = 'Check for an update from your Tern server.';
  @override
  void initState() {
    super.initState();
    inspect();
  }

  Future<void> inspect() async {
    final current = await updater.readCurrentPatch();
    final next = await updater.readNextPatch();
    if (!mounted) return;
    setState(() {
      currentPatch = current?.number;
      nextPatch = next?.number;
    });
    debugPrint(
      'TERN_RUNTIME variant=$variant current=${currentPatch ?? 0} next=${nextPatch ?? 0} available=${updater.isAvailable}',
    );
  }

  Future<void> check() async {
    setState(() {
      busy = true;
      message = 'Checking for an update…';
    });
    try {
      final status = await updater.checkForUpdate(track: UpdateTrack.staging);
      if (status == UpdateStatus.outdated) {
        if (mounted) {
          setState(() {
            message = 'Downloading and verifying the patch…';
          });
        }
        await updater.update(track: UpdateTrack.staging);
        message = 'Patch downloaded. Close and reopen the app to use it.';
      } else if (status == UpdateStatus.restartRequired) {
        message = 'Restart required. Close and reopen the app.';
      } else if (status == UpdateStatus.unavailable) {
        message =
            'Runtime unavailable. Build with Tern’s pinned Flutter toolchain.';
      } else {
        message = 'Update check complete. This app is up to date.';
      }
      await inspect();
    } catch (error) {
      message = 'Update failed: $error';
      debugPrint('TERN_RUNTIME error=$error');
    } finally {
      if (mounted) {
        setState(() {
          busy = false;
        });
      }
    }
  }

  Widget info(String label, String value) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 8),
    child: Row(
      children: [
        Expanded(
          child: Text(
            label,
            style: const TextStyle(fontSize: 14, color: Color(0xff758096)),
          ),
        ),
        Text(
          value,
          style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
        ),
      ],
    ),
  );

  @override
  Widget build(BuildContext context) {
    const accent = patched ? Color(0xffc56842) : Color(0xff3461e8);
    return Scaffold(
      appBar: AppBar(
        title: const Text(
          'tern',
          style: TextStyle(fontWeight: FontWeight.w700),
        ),
        backgroundColor: const Color(0xfff6f8fc),
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(24),
          children: [
            const SizedBox(height: 12),
            const Text(
              'FLUTTER CODE PUSH',
              style: TextStyle(
                fontSize: 14,
                color: Color(0xff758096),
                letterSpacing: 1.6,
              ),
            ),
            const SizedBox(height: 14),
            Text(
              patched ? 'The fix has landed.' : 'Ready for the next fix.',
              style: const TextStyle(
                fontSize: 34,
                fontWeight: FontWeight.w700,
                height: 1.12,
              ),
            ),
            const SizedBox(height: 22),
            Container(
              padding: const EdgeInsets.all(24),
              decoration: BoxDecoration(
                color: accent,
                borderRadius: BorderRadius.circular(16),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(
                    Icons.flight_takeoff_rounded,
                    size: 36,
                    color: Colors.white,
                  ),
                  const SizedBox(height: 24),
                  Text(
                    patched ? 'PATCHED · Coral build' : 'BASELINE · Blue build',
                    style: const TextStyle(
                      fontSize: 20,
                      color: Colors.white,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 9),
                  Text(
                    patched
                        ? 'This text and color came from downloaded Dart code.'
                        : 'This is the code installed in the original APK.',
                    style: const TextStyle(
                      fontSize: 16,
                      color: Colors.white,
                      height: 1.5,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 24),
            info(
              'Updater runtime',
              updater.isAvailable ? 'Available' : 'Unavailable',
            ),
            info(
              'Running patch',
              currentPatch == null ? 'Store release' : 'Patch $currentPatch',
            ),
            info(
              'Next boot patch',
              nextPatch == null ? 'Store release' : 'Patch $nextPatch',
            ),
            info('Update channel', 'Staging'),
            const SizedBox(height: 16),
            FilledButton.icon(
              onPressed: busy ? null : check,
              icon: const Icon(Icons.sync),
              label: Padding(
                padding: const EdgeInsets.symmetric(vertical: 14),
                child: Text(
                  busy ? 'Checking…' : 'Check for update',
                  style: const TextStyle(fontSize: 16),
                ),
              ),
            ),
            const SizedBox(height: 16),
            Semantics(
              liveRegion: true,
              child: Text(
                message,
                style: const TextStyle(fontSize: 16, height: 1.5),
              ),
            ),
            const SizedBox(height: 24),
            const Text(
              'Only install the original APK. Tern delivers subsequent Dart changes through its update API.',
              style: TextStyle(
                fontSize: 14,
                color: Color(0xff758096),
                height: 1.5,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
