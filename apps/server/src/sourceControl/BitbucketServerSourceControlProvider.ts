import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { SourceControlProviderError } from "@t3tools/contracts";

import * as BitbucketServerApi from "./BitbucketServerApi.ts";
import { toBitbucketChangeRequest } from "./bitbucketPullRequests.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import type { SourceControlApiDiscoverySpec } from "./SourceControlProviderDiscovery.ts";

export const make = Effect.gen(function* () {
  const bitbucket = yield* BitbucketServerApi.BitbucketServerApi;

  return SourceControlProvider.SourceControlProvider.of({
    kind: "bitbucket-server",
    listChangeRequests: (input) => {
      const source = SourceControlProvider.sourceControlRefFromInput(input);
      return bitbucket
        .listPullRequests({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
          headSelector: input.headSelector,
          ...(source ? { source } : {}),
          state: input.state,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        })
        .pipe(
          Effect.map((items) =>
            items.map((item) => toBitbucketChangeRequest("bitbucket-server", item)),
          ),
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "bitbucket-server",
                operation: "listChangeRequests",
                cwd: input.cwd,
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.headSelector,
                ),
                detail: "Failed to list change requests.",
                cause: error,
              }),
          ),
        );
    },
    getChangeRequest: (input) =>
      bitbucket.getPullRequest(input).pipe(
        Effect.map((item) => toBitbucketChangeRequest("bitbucket-server", item)),
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "bitbucket-server",
              operation: "getChangeRequest",
              cwd: input.cwd,
              reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                input.reference,
              ),
              detail: "Failed to get change request.",
              cause: error,
            }),
        ),
      ),
    createChangeRequest: (input) => {
      const source = SourceControlProvider.sourceControlRefFromInput(input);
      return bitbucket
        .createPullRequest({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
          baseBranch: input.baseRefName,
          headSelector: input.headSelector,
          ...(source ? { source } : {}),
          ...(input.target ? { target: input.target } : {}),
          title: input.title,
          bodyFile: input.bodyFile,
        })
        .pipe(
          Effect.asVoid,
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "bitbucket-server",
                operation: "createChangeRequest",
                cwd: input.cwd,
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.headSelector,
                ),
                detail: "Failed to create change request.",
                cause: error,
              }),
          ),
        );
    },
    getRepositoryCloneUrls: (input) =>
      bitbucket.getRepositoryCloneUrls(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "bitbucket-server",
              operation: "getRepositoryCloneUrls",
              cwd: input.cwd,
              repository: SourceControlProvider.transportSafeSourceControlErrorValue(
                input.repository,
              ),
              detail: "Failed to get repository clone URLs.",
              cause: error,
            }),
        ),
      ),
    createRepository: (input) =>
      new SourceControlProviderError({
        provider: "bitbucket-server",
        operation: "createRepository",
        cwd: input.cwd,
        repository: SourceControlProvider.transportSafeSourceControlErrorValue(input.repository),
        detail:
          "Bitbucket Data Center does not support publishing repositories from T3 Code. Create the repository on the host, then add it as a remote.",
      }),
    getDefaultBranch: (input) =>
      bitbucket
        .getDefaultBranch({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "bitbucket-server",
                operation: "getDefaultBranch",
                cwd: input.cwd,
                detail: "Failed to get default branch.",
                cause: error,
              }),
          ),
        ),
    checkoutChangeRequest: (input) =>
      bitbucket
        .checkoutPullRequest({
          cwd: input.cwd,
          ...(input.context ? { context: input.context } : {}),
          reference: input.reference,
          ...(input.force !== undefined ? { force: input.force } : {}),
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "bitbucket-server",
                operation: "checkoutChangeRequest",
                cwd: input.cwd,
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.reference,
                ),
                detail: "Failed to check out change request.",
                cause: error,
              }),
          ),
        ),
  });
});

export const makeDiscovery = Effect.gen(function* () {
  const bitbucket = yield* BitbucketServerApi.BitbucketServerApi;

  return {
    type: "api",
    kind: "bitbucket-server",
    label: "Bitbucket Data Center",
    installHint: "Add a Bitbucket Data Center host and token in Settings → Source Control.",
    // Settings show only the setup hint for an unauthenticated API integration, so a token the
    // host refused (a host is only reported once one is configured) reports as unverified there.
    probeAuth: bitbucket.probeAuth.pipe(
      Effect.map((auth) =>
        auth.status === "unauthenticated" && Option.isSome(auth.host)
          ? { ...auth, status: "unknown" as const }
          : auth,
      ),
    ),
  } satisfies SourceControlApiDiscoverySpec;
});
