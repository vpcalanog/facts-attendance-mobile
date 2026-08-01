// Design tokens for FACTS Attendance.
// The palette is pulled directly from the logo mark: a bright signal red
// blade fading into a near-black void, with a warm (not blue) dark base
// instead of the generic navy/slate a template would reach for.

export const BRAND = {
  // Surfaces
  void: "#0A0708", // app background — near-black with a whisper of red
  surface: "#1B1114", // card / input background
  surfaceRaised: "#241417", // slightly lifted surface (rows, chips)
  line: "#3A2226", // hairline borders/dividers

  // Brand red, from the logo's bright vertex down to its shadow
  signal: "#FF2E2E",
  signalDim: "rgba(255,46,46,0.14)",
  crimson: "#B0121A",
  crimsonDeep: "#3D0A0A",

  // Text
  bone: "#F5EDE9", // primary text — warm off-white, not stark white
  smoke: "#A3878B", // secondary/muted text — warm rose-gray

  // Status (kept semantic and distinct from brand red so state still reads
  // at a glance — synced/pending shouldn't fight with the primary color)
  amber: "#EAB308",
  amberDim: "rgba(234,179,8,0.14)",
  green: "#22C55E",
  greenDim: "rgba(34,197,94,0.14)",
  danger: "#FF5A5A"
};

// Single source of truth for the logo asset.
export const LOGO_SOURCE = require("../assets/images/facts-logo.png");
