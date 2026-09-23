// Expo's Metro bundler applies babel-preset-expo implicitly, but Jest
// does not — without this file the Flow-typed sources inside react-native
// fail to parse. The preset is the same one Metro already uses, so this
// changes nothing about how the app itself is bundled.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
  };
};
