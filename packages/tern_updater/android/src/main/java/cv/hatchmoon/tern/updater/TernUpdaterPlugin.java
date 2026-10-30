package cv.hatchmoon.tern.updater;

import android.app.Activity;
import android.content.Intent;
import android.os.Process;
import android.os.Handler;
import android.os.Looper;
import android.content.Context;
import java.util.HashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import androidx.annotation.NonNull;
import io.flutter.embedding.engine.plugins.FlutterPlugin;
import io.flutter.embedding.engine.plugins.activity.ActivityAware;
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding;
import io.flutter.plugin.common.MethodCall;
import io.flutter.plugin.common.MethodChannel;
import io.flutter.embedding.engine.renderer.FlutterRenderer;
import io.flutter.embedding.engine.renderer.FlutterUiDisplayListener;

/** Native cold restart; does not recreate just the Flutter engine. */
public final class TernUpdaterPlugin implements FlutterPlugin, MethodChannel.MethodCallHandler, ActivityAware {
    private MethodChannel channel;
    private Activity activity;
    private boolean restarting;
    private Context context;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private FlutterRenderer renderer;
    private FlutterUiDisplayListener firstFrame;
    private TernNativeRuntime.StatusListener status;

    @Override public void onAttachedToEngine(@NonNull FlutterPluginBinding binding) {
        context = binding.getApplicationContext();
        channel = new MethodChannel(binding.getBinaryMessenger(), "cv.hatchmoon.tern/updater");
        channel.setMethodCallHandler(this);
        renderer=renderer(binding);
        firstFrame=new FlutterUiDisplayListener() {
            private boolean confirmed;
            @Override public void onFlutterUiDisplayed() {
                if(confirmed)return;confirmed=true;
                worker.execute(()->{TernNativeRuntime runtime=TernNativeRuntime.get(context);runtime.markHealthy();runtime.automaticUpdate();});
            }
            @Override public void onFlutterUiNoLongerDisplayed() {}
        };
        renderer.addIsDisplayingFlutterUiListener(firstFrame);
        // Download progress, including the automatic download after the first frame.
        status = (available, downloading, received, total) -> main.post(() -> {
            if (channel != null) channel.invokeMethod("status", statusMap(new long[] { available, downloading, received, total }));
        });
        TernNativeRuntime.setStatusListener(status);
    }
    /** The engine's texture registry is its renderer; getFlutterEngine() is deprecated. */
    @SuppressWarnings("deprecation")
    private static FlutterRenderer renderer(FlutterPluginBinding binding) {
        if (binding.getTextureRegistry() instanceof FlutterRenderer value) return value;
        // Keep first-frame confirmation working; without it every patch would be reverted.
        return binding.getFlutterEngine().getRenderer();
    }
    private static HashMap<String, Object> statusMap(long[] value) {
        HashMap<String, Object> map = new HashMap<>();
        map.put("available", (int) value[0]); map.put("downloading", (int) value[1]); map.put("received", value[2]); map.put("total", value[3]);
        return map;
    }
    @Override public void onMethodCall(@NonNull MethodCall call, @NonNull MethodChannel.Result result) {
        // Answered immediately so status stays readable while a download holds the worker.
        if (call.method.equals("readPatches")) {
            TernNativeRuntime runtime = TernNativeRuntime.get(context);
            HashMap<String, Object> patches = new HashMap<>();
            patches.put("current", runtime.current()); patches.put("next", runtime.next()); patches.put("available", runtime.available());
            result.success(patches); return;
        }
        if (call.method.equals("readStatus")) { result.success(statusMap(TernNativeRuntime.get(context).status())); return; }
        if (call.method.equals("check") || call.method.equals("download") || call.method.equals("markHealthy")) {
            final Context app = context;
            worker.execute(() -> {
                try {
                    TernNativeRuntime runtime = TernNativeRuntime.get(app);
                    Object value = null;
                    if (call.method.equals("check")) value = runtime.check(call.argument("channel"));
                    else if (call.method.equals("download")) runtime.download(call.argument("channel"));
                    else runtime.markHealthy();
                    final Object response = value;
                    main.post(() -> result.success(response));
                } catch (Exception error) { main.post(() -> result.error("tern_runtime", error.getMessage(), null)); }
            });
            return;
        }
        if (call.method.equals("canRestart")) { result.success(true); return; }
        if (!call.method.equals("restart")) { result.notImplemented(); return; }
        final Activity current = activity;
        if (current == null || current.isFinishing() || current.isDestroyed() || !current.hasWindowFocus()) {
            result.error("not_foreground", "Bring the app to the foreground before restarting.", null); return;
        }
        if (restarting) { result.error("restart_in_progress", "A restart is already in progress.", null); return; }
        if (current.getPackageManager().getLaunchIntentForPackage(current.getPackageName()) == null) {
            result.error("no_launcher", "This app has no launcher activity.", null); return;
        }
        try {
            restarting = true;
            Intent helper = new Intent(current, TernRestartActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK | Intent.FLAG_ACTIVITY_NO_ANIMATION)
                .putExtra(TernRestartActivity.ORIGINAL_PID, Process.myPid());
            current.startActivity(helper);
            result.success(null);
        } catch (RuntimeException error) {
            restarting = false; result.error("restart_failed", error.getMessage(), null);
        }
    }
    @Override public void onDetachedFromEngine(@NonNull FlutterPluginBinding binding) { TernNativeRuntime.clearStatusListener(status); renderer.removeIsDisplayingFlutterUiListener(firstFrame); channel.setMethodCallHandler(null); channel = null; }
    @Override public void onAttachedToActivity(@NonNull ActivityPluginBinding binding) { activity = binding.getActivity(); }
    @Override public void onReattachedToActivityForConfigChanges(@NonNull ActivityPluginBinding binding) { activity = binding.getActivity(); }
    @Override public void onDetachedFromActivityForConfigChanges() { activity = null; }
    @Override public void onDetachedFromActivity() { activity = null; }
}
