/**
 * The Bitbucket Data Center driver: repository operations and discovery through the Data Center
 * REST API.
 *
 * @module source-control-bitbucket-server/server/driver
 */
import { defineSourceControlDriver } from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";

import { definition } from "../client/definition.ts";
import * as BitbucketServerSourceControlProvider from "./BitbucketServerSourceControlProvider.ts";

export const driver = defineSourceControlDriver({
  kind: definition.kind,
  make: Effect.all({
    sourceControl: BitbucketServerSourceControlProvider.make,
    discovery: BitbucketServerSourceControlProvider.makeDiscovery,
    pullRequests: Effect.succeed(null),
  }),
});
