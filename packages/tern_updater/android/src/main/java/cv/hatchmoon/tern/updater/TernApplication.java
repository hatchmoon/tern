package cv.hatchmoon.tern.updater;

import android.app.Application;
import android.content.Context;
import android.util.Log;
import io.flutter.FlutterInjector;
import io.flutter.embedding.engine.FlutterJNI;
import io.flutter.embedding.engine.loader.FlutterLoader;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.concurrent.Executors;

/** Installs Tern's AOT selection before any Flutter engine is initialized. */
public class TernApplication extends Application {
    @Override public void onCreate() {
        super.onCreate();
        install(this);
    }

    /** Custom Application classes may call this before initializing Flutter. */
    public static void install(Context context) {
        if (android.os.Build.VERSION.SDK_INT >= 28 && android.app.Application.getProcessName().endsWith(":tern_restart")) return;
        TernNativeRuntime runtime = TernNativeRuntime.get(context);
        if (!runtime.available()) return;
        FlutterInjector.setInstance(new FlutterInjector.Builder().setFlutterLoader(new FlutterLoader(new FlutterJNI(), Executors.newCachedThreadPool()) {
            @Override public void ensureInitializationComplete(Context context, String[] args) {
                if (initialized()) return;
                ArrayList<String> options = new ArrayList<>();
                if (args != null) options.addAll(Arrays.asList(args));
                options.removeIf(value -> value.startsWith("--aot-shared-library-name="));
                String path = runtime.selectForLaunch();
                if (path != null) options.add("--aot-shared-library-name=" + path);
                Log.i("TernRuntime", "Starting official Flutter; patch=" + runtime.current());
                super.ensureInitializationComplete(context, options.toArray(new String[0]));
            }
        }).build());
    }
}
