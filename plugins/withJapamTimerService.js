// Config plugin: injects the Kotlin native timer ForegroundService into the Android build.
// Runs during `expo prebuild` (or EAS Build's prebuild step).
const { withAndroidManifest, withMainApplication, withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const PKG = 'com.japamapp.mantrajapam';
const PKG_PATH = PKG.replace(/\./g, '/');

function withJapamTimerService(config) {
  config = addManifestEntries(config);
  config = patchMainApplication(config);
  config = copyNativeFiles(config);
  return config;
}

// ── 1. AndroidManifest: declare the service ──────────────────────────────────

function addManifestEntries(config) {
  return withAndroidManifest(config, (c) => {
    const manifest = c.modResults.manifest;
    const app = manifest.application?.[0];
    if (!app) return c;

    if (!app.service) app.service = [];

    const serviceName = `${PKG}.JapamTimerService`;
    const exists = app.service.some((s) => s.$?.['android:name'] === serviceName);

    if (!exists) {
      app.service.push({
        $: {
          'android:name': serviceName,
          'android:foregroundServiceType': 'mediaPlayback',
          'android:exported': 'false',
        },
      });
    }

    return c;
  });
}

// ── 2. MainApplication.kt: register the ReactPackage ─────────────────────────

function patchMainApplication(config) {
  return withMainApplication(config, (c) => {
    let src = c.modResults.contents;

    if (src.includes('JapamTimerPackage')) return c; // already patched

    // Insert import — try ReactNativeHostWrapper first, fall back to class declaration
    if (src.includes('import expo.modules.ReactNativeHostWrapper')) {
      src = src.replace(
        /(import expo\.modules\.ReactNativeHostWrapper)/,
        `import ${PKG}.JapamTimerPackage\n$1`
      );
    } else {
      src = src.replace(
        /(class MainApplication)/,
        `import ${PKG}.JapamTimerPackage\n\n$1`
      );
    }

    // Pattern A: older RN template — val packages = PackageList(this).packages ... return packages
    const patternA = /val packages = PackageList\(this\)\.packages([\s\S]*?)(\n(\s+)return packages)/;
    if (patternA.test(src)) {
      src = src.replace(
        patternA,
        (match, middle, returnPart, indent) =>
          `val packages = PackageList(this).packages${middle}\n${indent}packages.add(JapamTimerPackage())${returnPart}`
      );
    } else {
      // Pattern B: RN 0.76+ / Expo SDK 53+ template — PackageList(this).packages.apply { }
      // This is the pattern used in production builds that caused the silent registration failure.
      const patternB = /(PackageList\(this\)\.packages\.apply\s*\{\n)(\s*)/;
      if (patternB.test(src)) {
        src = src.replace(
          patternB,
          (_, open, indent) => `${open}${indent}add(JapamTimerPackage())\n${indent}`
        );
      } else {
        console.error(
          '[withJapamTimerService] ERROR: Could not find package registration point in MainApplication.kt. ' +
          'JapamTimerPackage will NOT be registered and NativeModules.JapamTimerService will be null at runtime.'
        );
      }
    }

    c.modResults.contents = src;
    return c;
  });
}

// ── 3. Copy Kotlin sources + sound asset during prebuild ─────────────────────

function copyNativeFiles(config) {
  return withDangerousMod(config, [
    'android',
    async (c) => {
      const projectRoot = c.modRequest.projectRoot;
      const androidRoot = c.modRequest.platformProjectRoot; // → android/

      const srcDir = path.join(projectRoot, 'android-native');
      const destDir = path.join(
        androidRoot,
        'app', 'src', 'main', 'java',
        ...PKG_PATH.split('/')
      );
      const rawDir = path.join(androidRoot, 'app', 'src', 'main', 'res', 'raw');

      fs.mkdirSync(destDir, { recursive: true });
      fs.mkdirSync(rawDir, { recursive: true });

      const ktFiles = ['JapamTimerService.kt', 'JapamTimerModule.kt', 'JapamTimerPackage.kt'];
      for (const file of ktFiles) {
        const src = path.join(srcDir, file);
        const dest = path.join(destDir, file);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, dest);
          console.log(`[withJapamTimerService] Copied ${file} → ${dest}`);
        } else {
          console.warn(`[withJapamTimerService] WARNING: ${src} not found`);
        }
      }

      // Copy Om completion sound into raw resources so MediaPlayer can load it
      const soundSrc = path.join(projectRoot, 'assets', 'om_complete.mp3');
      const soundDest = path.join(rawDir, 'om_complete.mp3');
      if (fs.existsSync(soundSrc)) {
        fs.copyFileSync(soundSrc, soundDest);
        console.log(`[withJapamTimerService] Copied om_complete.mp3 → ${soundDest}`);
      } else {
        console.warn('[withJapamTimerService] WARNING: assets/om_complete.mp3 not found');
      }

      return c;
    },
  ]);
}

module.exports = withJapamTimerService;
