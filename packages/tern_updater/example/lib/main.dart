import 'package:flutter/material.dart';
import 'package:tern_updater/tern_updater.dart';

const variant = String.fromEnvironment(
  'TERN_SDK_VARIANT',
  defaultValue: 'baseline',
);
void main() => runApp(const TernExample());

class TernExample extends StatefulWidget {
  const TernExample({super.key});
  @override
  State<TernExample> createState() => _TernExampleState();
}

class _TernExampleState extends State<TernExample> {
  final updates = TernUpdateController(
    channel: TernUpdateChannel.staging,
    pollInterval: const Duration(seconds: 2),
    checkInterval: const Duration(seconds: 10),
  );
  @override
  void initState() {
    super.initState();
    updates.addListener(report);
  }

  void report() {
    final state = updates.state;
    debugPrint(
      'TERN_SDK variant=$variant current=${state.currentPatch} next=${state.nextPatch} phase=${state.phase.name} canRestart=${state.canRestart}',
    );
  }

  @override
  Widget build(BuildContext context) => TernUpdateScope(
    controller: updates,
    child: MaterialApp(
      title: 'Tern integration',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        colorSchemeSeed: variant == 'patched'
            ? Colors.teal
            : const Color(0xff3461e8),
      ),
      home: const ExampleHome(),
    ),
  );
  @override
  void dispose() {
    updates.removeListener(report);
    updates.dispose();
    super.dispose();
  }
}

class ExampleHome extends StatefulWidget {
  const ExampleHome({super.key});
  @override
  State<ExampleHome> createState() => _ExampleHomeState();
}

class _ExampleHomeState extends State<ExampleHome> {
  final notes = TextEditingController();
  @override
  Widget build(BuildContext context) {
    final updates = TernUpdateScope.of(context), state = updates.state;
    return Scaffold(
      appBar: AppBar(title: const Text('Tern integration')),
      body: Column(
        children: [
          TernUpdateBanner(
            showProgress: true,
            beforeRestart: () async {
              if (notes.text.isEmpty) return true;
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(
                  content: Text(
                    'Clear the sample note or copy it before restarting.',
                  ),
                ),
              );
              return false;
            },
          ),
          Expanded(
            child: ListView(
              padding: const EdgeInsets.all(24),
              children: [
                Text(
                  variant == 'patched'
                      ? 'The update has landed.'
                      : 'Ready for your next update.',
                  style: Theme.of(context).textTheme.headlineMedium,
                ),
                const SizedBox(height: 16),
                Text(
                  variant == 'patched'
                      ? 'This screen is running downloaded Dart code.'
                      : 'This is the original APK. A downloaded patch will change this screen.',
                  style: const TextStyle(fontSize: 16),
                ),
                const SizedBox(height: 24),
                Text(
                  'Running: ${state.currentPatch == 0 ? 'original release' : 'patch ${state.currentPatch}'}',
                  style: const TextStyle(fontSize: 16),
                ),
                Text(
                  'Next launch: ${state.nextPatch == 0 ? 'original release' : 'patch ${state.nextPatch}'}',
                  style: const TextStyle(fontSize: 16),
                ),
                Text(
                  'Status: ${state.phase.name}',
                  style: const TextStyle(fontSize: 14),
                ),
                const SizedBox(height: 16),
                OutlinedButton(
                  onPressed: state.busy
                      ? null
                      : () => updates.checkForUpdates(),
                  child: const Text('Check for updates'),
                ),
                const SizedBox(height: 24),
                TextField(
                  controller: notes,
                  decoration: const InputDecoration(
                    labelText: 'Sample unsaved note',
                    helperText:
                        'The restart guard asks you to clear this first.',
                  ),
                  maxLines: 2,
                ),
                if (state.phase == TernUpdatePhase.unavailable)
                  const Padding(
                    padding: EdgeInsets.only(top: 24),
                    child: Text(
                      'The update runtime is unavailable in a normal Flutter debug build. Use tern release to test a real patch.',
                      style: TextStyle(fontSize: 16),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  @override
  void dispose() {
    notes.dispose();
    super.dispose();
  }
}
