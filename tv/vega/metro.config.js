const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

/**
 * Spee on Vega.
 *
 * The hub protocol client (vega-voice-bridge, the vendored tarball in ../../vendor) is an
 * ordinary dependency, so Metro resolves its built dist/ inside this project and needs no custom
 * resolver. Keeping the default config keeps Vega's platform resolver, which maps `react-native`
 * to `@amazon-devices/react-native-kepler` (a custom resolveRequest silently drops that mapping).
 *
 * Install with `npm install --prefix tv/vega` so React Native 0.83 and the @amazon-devices
 * packages stay in this folder.
 *
 * @type {import('metro-config').MetroConfig}
 */
const config = {};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
