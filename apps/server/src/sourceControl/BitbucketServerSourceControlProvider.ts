import * as Effect from "effect/Effect";

import {
  providerAuth,
  type SourceControlApiDiscoverySpec,
} from "./SourceControlProviderDiscovery.ts";

export const CONFIGURATION_HINT =
  "Set T3CODE_BITBUCKET_SERVER_URL and T3CODE_BITBUCKET_SERVER_TOKEN on the server (use an HTTP access token with repository read/write and project read scopes).";

export const discovery = {
  type: "api",
  kind: "bitbucket-server",
  label: "Bitbucket Data Center",
  installHint: CONFIGURATION_HINT,
  probeAuth: Effect.succeed(
    providerAuth({ status: "unauthenticated", detail: CONFIGURATION_HINT }),
  ),
} satisfies SourceControlApiDiscoverySpec;
