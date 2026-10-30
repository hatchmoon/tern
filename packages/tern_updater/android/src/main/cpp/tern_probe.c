// Diagnostic only: repeats the engine's AOT library lookup (flutter/runtime/dart_snapshot.cc).
#define _GNU_SOURCE
#include <dlfcn.h>
#include <jni.h>
#include <stdio.h>
#include <string.h>

static void append(char* out, size_t size, const char* text) {
  size_t used = strlen(out);
  if (used + 1 < size) snprintf(out + used, size - used, "%s", text);
}

JNIEXPORT jstring JNICALL
Java_cv_hatchmoon_tern_updater_TernProbe_probe(JNIEnv* env, jclass type, jstring jpath) {
  static const char* symbols[] = {"kDartVmSnapshotData", "kDartVmSnapshotInstructions",
                                  "kDartIsolateSnapshotData", "kDartIsolateSnapshotInstructions"};
  char out[2048] = "", line[512];
  (void)type;
  const char* path = (*env)->GetStringUTFChars(env, jpath, NULL);
  dlerror();
  void* handle = dlopen(path, RTLD_NOW);
  if (handle == NULL) {
    const char* error = dlerror();
    snprintf(line, sizeof line, "dlopen failed: %s", error ? error : "(no dlerror)");
    append(out, sizeof out, line);
  } else {
    append(out, sizeof out, "dlopen ok");
    for (size_t i = 0; i < sizeof symbols / sizeof symbols[0]; i++) {
      char underscored[64];
      snprintf(underscored, sizeof underscored, "_%s", symbols[i]);
      dlerror();
      void* symbol = dlsym(handle, symbols[i]);
      const char* used = symbols[i];
      if (symbol == NULL) { dlerror(); symbol = dlsym(handle, underscored); used = underscored; }
      if (symbol == NULL) {
        const char* error = dlerror();
        snprintf(line, sizeof line, "; %s missing (%s)", symbols[i], error ? error : "no dlerror");
      } else {
        Dl_info info;
        const char* file = dladdr(symbol, &info) && info.dli_fname ? info.dli_fname : "?";
        snprintf(line, sizeof line, "; %s found in %s", used, file);
      }
      append(out, sizeof out, line);
    }
    dlclose(handle);
  }
  (*env)->ReleaseStringUTFChars(env, jpath, path);
  return (*env)->NewStringUTF(env, out);
}
