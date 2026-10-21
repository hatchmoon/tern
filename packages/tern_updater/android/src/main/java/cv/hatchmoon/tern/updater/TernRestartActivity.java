package cv.hatchmoon.tern.updater;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.util.Log;

/** Non-exported helper in its own process, allowing the original process to die. */
public final class TernRestartActivity extends Activity {
    static final String ORIGINAL_PID = "tern_original_pid";
    private final Handler handler = new Handler(Looper.getMainLooper());
    private int oldPid;
    private int attempts;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        oldPid = getIntent().getIntExtra(ORIGINAL_PID, -1);
        if (oldPid <= 0 || oldPid == Process.myPid()) { finish(); return; }
        // Not exported. Linux only permits killing a process with our UID.
        Process.killProcess(oldPid);
        handler.postDelayed(this::launchWhenStopped, 50);
    }
    private void launchWhenStopped() {
        boolean alive;
        try { Os.kill(oldPid, 0); alive = true; }
        catch (ErrnoException error) { alive = error.errno != OsConstants.ESRCH; }
        if (alive) {
            if (++attempts < 100) { handler.postDelayed(this::launchWhenStopped, 20); return; }
            Log.e("TernUpdater", "Original process did not stop. Reopen the app manually.");
            finish(); return;
        }
        Intent launcher = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launcher != null) {
            launcher.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
            try { startActivity(launcher); }
            catch (RuntimeException error) { Log.e("TernUpdater", "Reopen the app manually.", error); }
        }
        finish();
        handler.postDelayed(() -> Process.killProcess(Process.myPid()), 250);
    }
}
