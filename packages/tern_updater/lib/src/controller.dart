import 'dart:async';
import 'package:flutter/foundation.dart';
import 'runtime.dart';

enum TernUpdatePhase {
  idle,
  checking,
  downloading,
  upToDate,
  restartRequired,
  restarting,
  unavailable,
  failed,
}

@immutable
class TernUpdateState {
  const TernUpdateState({
    this.phase = TernUpdatePhase.idle,
    this.currentPatch = 0,
    this.nextPatch = 0,
    this.canRestart = false,
    this.dismissed = false,
    this.error,
  });
  final TernUpdatePhase phase;
  final int currentPatch;
  final int nextPatch;
  final bool canRestart;
  final bool dismissed;
  final Object? error;
  bool get restartRequired => currentPatch != nextPatch;
  bool get busy =>
      phase == TernUpdatePhase.checking ||
      phase == TernUpdatePhase.downloading ||
      phase == TernUpdatePhase.restarting;
}

/// One controller per app process. Never restarts the app automatically.
class TernUpdateController extends ChangeNotifier {
  TernUpdateController({
    TernUpdateDriver? driver,
    this.channel = TernUpdateChannel.stable,
    this.checkInterval = const Duration(minutes: 5),
    this.pollInterval = const Duration(seconds: 15),
  }) : assert(checkInterval > Duration.zero),
       assert(pollInterval > Duration.zero),
       _driver = driver ?? TernRuntimeDriver();
  final TernUpdateDriver _driver;
  final TernUpdateChannel channel;
  final Duration checkInterval;
  final Duration pollInterval;
  TernUpdateState _state = const TernUpdateState();
  TernUpdateState get state => _state;
  Timer? _timer;
  Future<void>? _operation;
  DateTime? _lastCheck;
  String? _dismissedKey;
  bool _disposed = false;

  void _emit(TernUpdateState value) {
    if (_disposed) return;
    _state = value;
    notifyListeners();
  }

  void _phase(TernUpdatePhase phase, {Object? error}) => _emit(
    TernUpdateState(
      phase: phase,
      currentPatch: _state.currentPatch,
      nextPatch: _state.nextPatch,
      canRestart: _state.canRestart,
      dismissed: _state.dismissed,
      error: error,
    ),
  );
  Future<void> _inspect({Object? error}) async {
    final patches = await _driver.readPatches();
    final restart = await _driver.canRestart();
    if (_disposed) return;
    if (!patches.restartRequired) _dismissedKey = null;
    _emit(
      TernUpdateState(
        phase:
            patches.restartRequired
                ? TernUpdatePhase.restartRequired
                : error == null
                ? TernUpdatePhase.upToDate
                : TernUpdatePhase.failed,
        currentPatch: patches.current,
        nextPatch: patches.next,
        canRestart: restart,
        dismissed: _dismissedKey == '${patches.current}:${patches.next}',
        error: error,
      ),
    );
  }

  Future<void> _exclusive(Future<void> Function() work) {
    if (_disposed) return Future.value();
    if (_operation != null) return _operation!;
    final done = Completer<void>();
    _operation = done.future;
    unawaited(() async {
      try {
        await work();
        done.complete();
      } catch (error, stack) {
        done.completeError(error, stack);
      } finally {
        _operation = null;
      }
    }());
    return done.future;
  }

  /// Starts foreground polling. Local checks also notice automatic downloads.
  Future<void> start() {
    if (_disposed) return Future.value();
    _timer ??= Timer.periodic(pollInterval, (_) {
      unawaited(checkForUpdates(force: false));
    });
    return checkForUpdates(force: false);
  }

  /// Pauses polling while the application is in the background.
  void stop() {
    _timer?.cancel();
    _timer = null;
  }

  /// Checks the selected channel and stages an available patch for next launch.
  /// Concurrent calls share one operation. Network failures are exposed in state.
  Future<void> checkForUpdates({bool force = true}) => _exclusive(() async {
    if (!_driver.isAvailable) {
      _emit(const TernUpdateState(phase: TernUpdatePhase.unavailable));
      return;
    }
    try {
      final due =
          force ||
          _lastCheck == null ||
          DateTime.now().difference(_lastCheck!) >= checkInterval;
      if (due) {
        _phase(TernUpdatePhase.checking);
        _lastCheck = DateTime.now();
        final available = await _driver.check(channel);
        if (_disposed) return;
        if (available == TernUpdateAvailability.unavailable) {
          _emit(const TernUpdateState(phase: TernUpdatePhase.unavailable));
          return;
        }
        if (available == TernUpdateAvailability.outdated) {
          _phase(TernUpdatePhase.downloading);
          await _driver.download(channel);
          if (_disposed) return;
        }
      }
      // A native automatic download can still be running. Only a committed
      // next-patch value makes the banner ready to restart.
      await _inspect();
    } catch (error) {
      if (_disposed) return;
      try {
        await _inspect(error: error);
      } catch (_) {
        _phase(TernUpdatePhase.failed, error: error);
      }
    }
  });

  /// Hides this pending patch's banner for this controller's lifetime.
  /// The staged patch remains on disk; a different patch shows again.
  void dismiss() {
    if (!_state.restartRequired || _state.busy) return;
    _dismissedKey = '${_state.currentPatch}:${_state.nextPatch}';
    _emit(
      TernUpdateState(
        phase: _state.phase,
        currentPatch: _state.currentPatch,
        nextPatch: _state.nextPatch,
        canRestart: _state.canRestart,
        dismissed: true,
        error: _state.error,
      ),
    );
  }

  /// Call after user confirmation and saving unfinished work. A successful
  /// Android call terminates this Dart isolate and the application process.
  Future<void> restart() async {
    if (_disposed || _operation != null || _state.busy) {
      throw StateError('Wait for the current update operation to finish.');
    }
    await _exclusive(() async {
      await _inspect();
      if (_disposed) return;
      if (!_state.restartRequired) {
        throw StateError('No downloaded update is waiting.');
      }
      if (!_state.canRestart) {
        throw UnsupportedError(
          'A new APK with the Tern restart plugin is required.',
        );
      }
      _phase(TernUpdatePhase.restarting);
      try {
        await _driver.restart();
      } catch (error) {
        if (!_disposed) await _inspect(error: error);
        rethrow;
      }
    });
  }

  @override
  void dispose() {
    stop();
    _disposed = true;
    super.dispose();
  }
}
