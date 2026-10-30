import 'dart:async';
import 'package:flutter/foundation.dart';
import 'runtime.dart';

enum TernUpdatePhase {
  idle,
  checking,

  /// A patch is offered but not downloaded. Only lasts while waiting for
  /// [TernUpdateController.downloadUpdate] when automatic download is off.
  available,
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
    this.availablePatch = 0,
    this.downloadingPatch = 0,
    this.receivedBytes = 0,
    this.totalBytes,
    this.canRestart = false,
    this.dismissed = false,
    this.error,
  });
  final TernUpdatePhase phase;
  final int currentPatch;
  final int nextPatch;

  /// Patch offered by the server and not staged yet; zero for none or unknown.
  final int availablePatch;

  /// Patch being downloaded; zero when idle or unknown.
  final int downloadingPatch;
  final int receivedBytes;

  /// Null when the download size is unknown.
  final int? totalBytes;
  final bool canRestart;
  final bool dismissed;
  final Object? error;
  bool get restartRequired => currentPatch != nextPatch;
  bool get busy =>
      phase == TernUpdatePhase.checking ||
      phase == TernUpdatePhase.downloading ||
      phase == TernUpdatePhase.restarting;

  /// From 0 to 1 while downloading, or null when the size is unknown.
  double? get downloadProgress {
    final total = totalBytes;
    if (phase != TernUpdatePhase.downloading || total == null || total <= 0) {
      return null;
    }
    return (receivedBytes / total).clamp(0.0, 1.0);
  }
}

/// One controller per app process. Never restarts the app automatically.
class TernUpdateController extends ChangeNotifier {
  TernUpdateController({
    TernUpdateDriver? driver,
    this.channel = TernUpdateChannel.stable,
    this.checkInterval = const Duration(minutes: 5),
    this.pollInterval = const Duration(seconds: 15),
    this.autoDownload = true,
  }) : assert(checkInterval > Duration.zero),
       assert(pollInterval > Duration.zero),
       _driver = driver ?? TernRuntimeDriver() {
    if (_driver case TernDownloadStatusSource source) {
      _statusChanges = source.statusChanges.listen(_onStatus);
    }
  }
  final TernUpdateDriver _driver;
  final TernUpdateChannel channel;
  final Duration checkInterval;
  final Duration pollInterval;

  /// When false, a found patch stays [TernUpdatePhase.available] until
  /// [downloadUpdate] is called. Build the baseline with `auto_update: false`
  /// in tern.yaml too, or the native runtime still downloads after launch.
  final bool autoDownload;
  TernUpdateState _state = const TernUpdateState();
  TernUpdateState get state => _state;
  Timer? _timer;
  Future<void>? _operation;
  DateTime? _lastCheck;
  String? _dismissedKey;
  bool _disposed = false;
  TernDownloadStatus _download = const TernDownloadStatus();
  StreamSubscription<TernDownloadStatus>? _statusChanges;

  /// Set when the last check offered a patch, for drivers without status.
  bool _offered = false;

  /// Identifies the staged or offered patch that Later hides.
  static String? _keyOf(TernUpdateState state) =>
      state.restartRequired
          ? 'r:${state.currentPatch}:${state.nextPatch}'
          : state.availablePatch > 0 || state.phase == TernUpdatePhase.available
          ? 'a:${state.availablePatch}'
          : null;

  void _emit(TernUpdateState value) {
    if (_disposed) return;
    if (_keyOf(value) != _dismissedKey) _dismissedKey = null;
    _state = TernUpdateState(
      phase: value.phase,
      currentPatch: value.currentPatch,
      nextPatch: value.nextPatch,
      availablePatch: value.availablePatch,
      downloadingPatch: value.downloadingPatch,
      receivedBytes: value.receivedBytes,
      totalBytes: value.totalBytes,
      canRestart: value.canRestart,
      dismissed: _dismissedKey != null,
      error: value.error,
    );
    notifyListeners();
  }

  void _phase(TernUpdatePhase phase, {Object? error}) => _emit(
    TernUpdateState(
      phase: phase,
      currentPatch: _state.currentPatch,
      nextPatch: _state.nextPatch,
      availablePatch: _download.availablePatch,
      downloadingPatch: _download.downloadingPatch,
      receivedBytes: _download.receivedBytes,
      totalBytes: _download.totalBytes,
      canRestart: _state.canRestart,
      error: error,
    ),
  );
  Future<void> _inspect({Object? error}) async {
    final patches = await _driver.readPatches();
    final restart = await _driver.canRestart();
    final download = switch (_driver) {
      TernDownloadStatusSource source => await source.readStatus(),
      _ => _download,
    };
    if (_disposed) return;
    _download = download;
    final offered = download.availablePatch > 0 || _offered;
    _emit(
      TernUpdateState(
        phase:
            download.downloading
                ? TernUpdatePhase.downloading
                : patches.restartRequired
                ? TernUpdatePhase.restartRequired
                : error != null
                ? TernUpdatePhase.failed
                : offered
                ? TernUpdatePhase.available
                : TernUpdatePhase.upToDate,
        currentPatch: patches.current,
        nextPatch: patches.next,
        availablePatch: download.availablePatch,
        downloadingPatch: download.downloadingPatch,
        receivedBytes: download.receivedBytes,
        totalBytes: download.totalBytes,
        canRestart: restart,
        error: error,
      ),
    );
  }

  /// Native progress, including downloads the runtime starts after launch.
  void _onStatus(TernDownloadStatus status) {
    if (_disposed) return;
    final finished = _download.downloading && !status.downloading;
    final offerChanged = status.availablePatch != _download.availablePatch;
    _download = status;
    if (status.downloading) {
      if (_state.phase != TernUpdatePhase.restarting) {
        _phase(TernUpdatePhase.downloading, error: _state.error);
      }
    } else if (_operation == null && (finished || offerChanged)) {
      // A running operation inspects when it ends.
      unawaited(
        _exclusive(() async {
          try {
            await _inspect();
          } catch (error) {
            _phase(TernUpdatePhase.failed, error: error);
          }
        }),
      );
    }
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
        _offered = available == TernUpdateAvailability.outdated;
        if (_offered && autoDownload) {
          _phase(TernUpdatePhase.downloading);
          await _driver.download(channel);
          if (_disposed) return;
          _offered = false;
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

  /// Downloads the offered patch and stages it for next launch. Call when the
  /// user chooses to download with `autoDownload: false`.
  Future<void> downloadUpdate() => _exclusive(() async {
    if (!_driver.isAvailable) {
      _emit(const TernUpdateState(phase: TernUpdatePhase.unavailable));
      return;
    }
    try {
      _phase(TernUpdatePhase.downloading);
      await _driver.download(channel);
      if (_disposed) return;
      _offered = false;
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

  /// Hides the banner for this staged or offered patch for this controller's
  /// lifetime. Nothing is deleted; a different patch shows again.
  void dismiss() {
    final key = _keyOf(_state);
    if (key == null || _state.busy) return;
    _dismissedKey = key;
    _emit(_state);
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
      if (_state.phase == TernUpdatePhase.downloading) {
        throw StateError('Wait for the download to finish.');
      }
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

  @override
  void dispose() {
    stop();
    unawaited(_statusChanges?.cancel());
    _disposed = true;
    super.dispose();
  }
}
