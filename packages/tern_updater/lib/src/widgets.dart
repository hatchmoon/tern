import 'dart:async';
import 'package:flutter/material.dart';
import 'controller.dart';

/// Place above MaterialApp or around the subtree that owns the app's routes.
class TernUpdateScope extends StatefulWidget {
  const TernUpdateScope({super.key, required this.child, this.controller});
  final Widget child;
  final TernUpdateController? controller;
  static TernUpdateController of(BuildContext context) {
    final scope = context.dependOnInheritedWidgetOfExactType<_TernInherited>();
    if (scope == null) {
      throw FlutterError('Place TernUpdateScope above TernUpdateBanner.');
    }
    return scope.notifier!;
  }

  @override
  State<TernUpdateScope> createState() => _TernUpdateScopeState();
}

class _TernUpdateScopeState extends State<TernUpdateScope>
    with WidgetsBindingObserver {
  late TernUpdateController _controller;
  void _attach() {
    _controller = widget.controller ?? TernUpdateController();
    unawaited(_controller.start());
  }

  void _detach(TernUpdateController? external) {
    _controller.stop();
    if (external == null) _controller.dispose();
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _attach();
  }

  @override
  void didUpdateWidget(TernUpdateScope oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.controller != oldWidget.controller) {
      _detach(oldWidget.controller);
      _attach();
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      unawaited(_controller.start());
    } else {
      _controller.stop();
    }
  }

  @override
  Widget build(BuildContext context) =>
      _TernInherited(notifier: _controller, child: widget.child);
  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _detach(widget.controller);
    super.dispose();
  }
}

class _TernInherited extends InheritedNotifier<TernUpdateController> {
  const _TernInherited({required super.notifier, required super.child});
}

/// Place below the home screen's AppBar, above existing content.
class TernUpdateBanner extends StatefulWidget {
  const TernUpdateBanner({super.key, this.controller, this.beforeRestart});
  final TernUpdateController? controller;

  /// Return false to defer restart, for example when a form has unsaved data.
  /// The confirmation dialog is still shown when this returns true.
  final Future<bool> Function()? beforeRestart;
  @override
  State<TernUpdateBanner> createState() => _TernUpdateBannerState();
}

class _TernUpdateBannerState extends State<TernUpdateBanner> {
  bool _confirming = false;
  Future<void> _restart(TernUpdateController controller) async {
    if (_confirming) return;
    setState(() => _confirming = true);
    try {
      if (widget.beforeRestart != null && !await widget.beforeRestart!()) {
        return;
      }
      if (!mounted) return;
      final confirmed = await showDialog<bool>(
        context: context,
        builder:
            (context) => AlertDialog(
              title: const Text('Restart app?'),
              content: const Text(
                'Save any unfinished work first. The app will close and reopen to apply the update.',
                style: TextStyle(fontSize: 16),
              ),
              actions: [
                TextButton(
                  onPressed: () => Navigator.pop(context, false),
                  child: const Text('Cancel'),
                ),
                FilledButton(
                  onPressed: () => Navigator.pop(context, true),
                  child: const Text('Restart'),
                ),
              ],
            ),
      );
      if (confirmed != true || !mounted) return;
      await controller.restart();
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.maybeOf(context)?.showSnackBar(
          const SnackBar(
            content: Text(
              'Could not restart. Close the app completely and reopen it to apply the update.',
            ),
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _confirming = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller ?? TernUpdateScope.of(context);
    return ListenableBuilder(
      listenable: controller,
      builder: (context, _) {
        final state = controller.state;
        if (!state.restartRequired || state.dismissed) {
          return const SizedBox.shrink();
        }
        final colors = Theme.of(context).colorScheme;
        final busy = _confirming || state.busy;
        return Semantics(
          container: true,
          liveRegion: true,
          child: Material(
            color: colors.primaryContainer,
            child: SafeArea(
              top: false,
              bottom: false,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 14, 16, 8),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Padding(
                          padding: const EdgeInsets.only(top: 2, right: 12),
                          child: Icon(
                            Icons.system_update_alt,
                            color: colors.onPrimaryContainer,
                          ),
                        ),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                'Update ready',
                                style: TextStyle(
                                  fontSize: 16,
                                  fontWeight: FontWeight.w700,
                                  color: colors.onPrimaryContainer,
                                ),
                              ),
                              const SizedBox(height: 4),
                              Text(
                                state.canRestart
                                    ? 'Restart to apply the latest update.'
                                    : 'Close the app completely and reopen it to apply the update.',
                                style: TextStyle(
                                  fontSize: 16,
                                  color: colors.onPrimaryContainer,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                    Align(
                      alignment: AlignmentDirectional.centerEnd,
                      child: Wrap(
                        spacing: 8,
                        children: [
                          TextButton(
                            onPressed: busy ? null : controller.dismiss,
                            style: TextButton.styleFrom(
                              minimumSize: const Size(64, 48),
                              foregroundColor: colors.onPrimaryContainer,
                              textStyle: const TextStyle(fontSize: 16),
                            ),
                            child: const Text('Later'),
                          ),
                          if (state.canRestart)
                            TextButton(
                              onPressed:
                                  busy ? null : () => _restart(controller),
                              style: TextButton.styleFrom(
                                minimumSize: const Size(100, 48),
                                foregroundColor: colors.onPrimaryContainer,
                                textStyle: const TextStyle(
                                  fontSize: 16,
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                              child: Text(
                                state.phase == TernUpdatePhase.restarting
                                    ? 'Restarting…'
                                    : 'Restart now',
                              ),
                            ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}
