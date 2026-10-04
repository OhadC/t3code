import * as Effect from "effect/Effect";
import { SourceControlProviderError } from "@t3tools/contracts";

import * as BitbucketApi from "./BitbucketApi.ts";
import { toBitbucketChangeRequest } from "./bitbucketPullRequests.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import type { SourceControlApiDiscoverySpec } from "./SourceControlProviderDiscovery.ts";

export const make = Effect.gen(function* () {
  const bitbucket = yield* BitbucketApi.BitbucketApi;

  return SourceControlProvider.SourceControlProvider.of({
    kind: "bitbucket",
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
          Effect.map((items) => items.map((item) => toBitbucketChangeRequest("bitbucket", item))),
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "bitbucket",
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
        Effect.map((item) => toBitbucketChangeRequest("bitbucket", item)),
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "bitbucket",
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
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "bitbucket",
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
              provider: "bitbucket",
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
      bitbucket.createRepository(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "bitbucket",
              operation: "createRepository",
              cwd: input.cwd,
              repository: SourceControlProvider.transportSafeSourceControlErrorValue(
                input.repository,
              ),
              detail: "Failed to create repository.",
              cause: error,
            }),
        ),
      ),
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
                provider: "bitbucket",
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
                provider: "bitbucket",
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
  const bitbucket = yield* BitbucketApi.BitbucketApi;

  return {
    type: "api",
    kind: "bitbucket",
    label: "Bitbucket",
    installHint: "Add a Bitbucket token in Settings → Source Control.",
    probeAuth: bitbucket.probeAuth,
  } satisfies SourceControlApiDiscoverySpec;
});
