const { withAndroidManifest } = require('@expo/config-plugins');

/**
 * Adds android:foregroundServiceType="dataSync" to the RNBackgroundActionsTask service.
 * Required on Android 14+ (API 34+) when using foreground service type 'dataSync'.
 */
module.exports = function withBackgroundActions(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    const application = manifest.application?.[0];
    if (!application) return config;

    if (!application.service) application.service = [];

    const fullName = 'com.asterinet.react.bgactions.RNBackgroundActionsTask';

    const existing = application.service.find(
      (s) => s.$?.['android:name'] === fullName || s.$?.['android:name'] === '.RNBackgroundActionsTask',
    );

    if (existing) {
      existing.$['android:foregroundServiceType'] = 'dataSync';
    } else {
      application.service.push({
        $: {
          'android:name': fullName,
          'android:foregroundServiceType': 'dataSync',
        },
      });
    }

    return config;
  });
};
