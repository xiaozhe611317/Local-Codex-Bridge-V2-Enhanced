// Replaced in dist only by scripts/write-build-identity.mjs after compilation.
// Direct source execution or plain tsc has no embedded artifact identity.
export const BUILD_IDENTITY: {
  status: "available" | "unavailable";
  source: string;
  sha256?: string;
} = { status: "unavailable", source: "No build fingerprint embedded" };
