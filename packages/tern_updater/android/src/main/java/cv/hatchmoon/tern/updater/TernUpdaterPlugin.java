package cv.hatchmoon.tern.updater;

import android.app.Activity;
import android.content.Intent;
import android.os.Process;
import androidx.annotation.NonNull;
import io.flutter.embedding.engine.plugins.FlutterPlugin;
import io.flutter.embedding.engine.plugins.activity.ActivityAware;
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding;
import io.flutter.plugin.common.MethodCall;
import io.flutter.plugin.common.MethodChannel;

/** Native cold restart; does not recreate just the Flutter engine. */
public final class TernUpdaterPlugin implements FlutterPlugin, MethodChannel.MethodCallHandler, ActivityAware {
    private MethodChannel channel;
    private Activity activity;
    private boolean restarting;

    @Override public void onAttachedToEngine(@NonNull FlutterPluginBinding binding) {
        channel = new MethodChannel(binding.getBinaryMessenger(), "cv.hatchmoon.tern/updater");
        channel.setMethodCallHandler(this);
    }
    @Override public void onMethodCall(@NonNull MethodCall call, @NonNull MethodChannel.Result result) {
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
    @Override public void onDetachedFromEngine(@NonNull FlutterPluginBinding binding) { channel.setMethodCallHandler(null); channel = null; }
    @Override public void onAttachedToActivity(@NonNull ActivityPluginBinding binding) { activity = binding.getActivity(); }
    @Override public void onReattachedToActivityForConfigChanges(@NonNull ActivityPluginBinding binding) { activity = binding.getActivity(); }
    @Override public void onDetachedFromActivityForConfigChanges() { activity = null; }
    @Override public void onDetachedFromActivity() { activity = null; }
}
