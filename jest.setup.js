// The tests here exercise the network, storage and sync logic, not the
// native modules underneath it. Each native dependency gets a small,
// controllable fake so a test can say "the server is down" or "the
// keystore is empty" without a device in the loop.

jest.mock("expo-secure-store", () => {
  const store = new Map();
  return {
    __store: store,
    getItemAsync: jest.fn(async (k) => (store.has(k) ? store.get(k) : null)),
    setItemAsync: jest.fn(async (k, v) => {
      store.set(k, v);
    }),
    deleteItemAsync: jest.fn(async (k) => {
      store.delete(k);
    }),
  };
});

jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: {
    fetch: jest.fn(async () => ({ isConnected: true, isInternetReachable: true })),
    addEventListener: jest.fn(() => () => {}),
  },
}));

jest.mock("expo-constants", () => ({
  __esModule: true,
  default: { expoConfig: { extra: {} } },
}));

global.__DEV__ = false;

// Exercise the bundled-account sign-in path. It is normally gated on
// __DEV__, which is false here so the logger stays quiet, so switch it
// on the same way a preview build would.
process.env.EXPO_PUBLIC_OFFLINE_AUTH = "1";
