import * as Effect from "effect/Effect";
import type { PullRequestCapabilities, PullRequestViewerPermissions } from "@t3tools/contracts";

import * as BitbucketServerPullRequestApi from "./BitbucketServerPullRequestApi.ts";
import {
  PullRequestProviderError,
  type PullRequestProviderFailure,
  type ProviderChangeRequest,
  type ProviderChangeRequestActivity,
  type ProviderChangeRequestDetail,
  type PullRequestProviderApi,
} from "./PullRequestProvider.ts";
import type { BitbucketServerPullRequest } from "./bitbucketServerPullRequestJson.ts";

const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: true,
  // Data Center declines and reopens through endpoints of its own. Draft is read-only on this
  // host, so neither direction of it is offered.
  actions: ["merge", "close", "reopen"],
  mergeMethods: ["merge", "squash", "rebase"],
  search: true,
  // Data Center's REST API carries no reaction on a pull request or a comment.
  reactions: false,
  // Reviews and reviewer requests arrive with the write half of this adapter.
  review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
  reviewers: { request: false, listCandidates: false },
};

/**
 * What the token may do here, from the one thing Data Center states per caller: whether it
 * holds write permission on the repository. Merging needs it, so that is what narrows. Declining
 * and reopening stay offered: an author may decline their own pull request with read access,
 * and the permission read says nothing about who opened this one.
 */
export function bitbucketServerViewerPermissions(input: {
  readonly canWrite: boolean;
}): PullRequestViewerPermissions {
  return {
    actions: CAPABILITIES.actions.filter((action) => action !== "merge" || input.canWrite),
    comment: true,
    resolve: false,
    verdicts: CAPABILITIES.review.verdicts,
    requestReviewers: false,
  };
}

/** The failures that mean the token or the configuration is the problem, rather than one request. */
export function bitbucketServerProviderFailure(
  error: BitbucketServerPullRequestApi.BitbucketServerPullRequestApiError,
): PullRequestProviderFailure {
  // Data Center is read over HTTP with a token from the environment, so there is no tool to be
  // missing: unusable always means the token is absent or refused.
  if (error._tag === "BitbucketServerNotConfiguredError") return { reason: "unauthenticated" };
  if (error._tag === "BitbucketServerViewerUnavailableError") {
    return { reason: error.reason === "unauthenticated" ? "unauthenticated" : "failed" };
  }
  if (error._tag === "BitbucketServerResponseError" && error.status === 401) {
    return { reason: "unauthenticated" };
  }
  if (error._tag === "BitbucketServerResponseError" && error.status === 429) {
    return {
      reason: "rate-limited",
      ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
    };
  }
  return { reason: "failed" };
}

function toChangeRequest(pullRequest: BitbucketServerPullRequest): ProviderChangeRequest {
  return {
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.url,
    author: pullRequest.author,
    headBranch: pullRequest.headBranch,
    ...(pullRequest.headRepositoryNameWithOwner
      ? { headRepositoryNameWithOwner: pullRequest.headRepositoryNameWithOwner }
      : {}),
    baseBranch: pullRequest.baseBranch,
    state: pullRequest.state,
    isDraft: pullRequest.isDraft,
    // The host states no conflict on a listing; the detail asks its merge check, which does.
    mergeability: "unknown",
    // The host states no line counts anywhere short of the patch itself, which is not worth
    // downloading twice for two numbers.
    additions: 0,
    deletions: 0,
    createdAt: pullRequest.createdAt,
    updatedAt: pullRequest.updatedAt,
    closedAt: pullRequest.closedAt,
    ...(pullRequest.state === "merged" ? { mergedAt: pullRequest.closedAt } : {}),
    reviewRequestLogins: pullRequest.reviewRequestLogins,
    // Data Center has no labels on a pull request.
    labels: [],
  };
}

export const make = Effect.gen(function* () {
  const api = yield* BitbucketServerPullRequestApi.BitbucketServerPullRequestApi;

  const fail =
    (operation: string) =>
    (error: BitbucketServerPullRequestApi.BitbucketServerPullRequestApiError) =>
      new PullRequestProviderError({
        provider: "bitbucket-server",
        operation,
        ...bitbucketServerProviderFailure(error),
        detail: error.detail,
        cause: error,
      });

  const unsupported = (operation: string) =>
    Effect.fail(
      new PullRequestProviderError({
        provider: "bitbucket-server",
        operation,
        reason: "failed",
        detail: "Bitbucket Data Center pull requests cannot be written to from here yet.",
      }),
    );

  const provider: PullRequestProviderApi = {
    kind: "bitbucket-server",
    capabilities: CAPABILITIES,

    // The token comes from the server's environment rather than a checkout, so the account is
    // the same whichever workspace asks.
    getViewer: () => api.getViewer().pipe(Effect.mapError(fail("getViewer"))),

    listChangeRequests: (input) =>
      api
        .listPullRequests({
          repository: input.repository,
          state: input.state,
          involvement: input.involvement,
          viewer: input.viewer,
          limit: input.limit,
          query: input.query,
          cursor: input.cursor,
        })
        .pipe(
          Effect.mapError(fail("listChangeRequests")),
          Effect.map((batch) => ({
            items: batch.items.map(toChangeRequest),
            truncated: batch.truncated,
            cursorAdvance: batch.cursorAdvance,
            // The host answers in one order (newest created first) whether or not it is being
            // carried on from, so a slice can always be stepped past — by counting, which is
            // what it pages by.
            continues: true,
          })),
        ),

    getChangeRequest: (input) => {
      const target = { repository: input.repository, number: input.number };
      return api.getPullRequest(target).pipe(
        Effect.flatMap((pullRequest) =>
          Effect.all(
            [
              api.getMergeability(target).pipe(Effect.orElseSucceed(() => "unknown" as const)),
              pullRequest.headCommit === null
                ? Effect.succeed([])
                : api
                    .listChecks({ commit: pullRequest.headCommit })
                    .pipe(Effect.orElseSucceed(() => [])),
              api.getChangedFileCount(target).pipe(Effect.orElseSucceed(() => 0)),
              // A permission that could not be read is an unknown one, which is granted: a
              // hidden Merge leaves someone entitled to it with no way through, and one the host
              // refuses at least says why.
              api.getRepositoryPermission(target).pipe(Effect.orElseSucceed(() => true)),
            ],
            { concurrency: 4 },
          ).pipe(
            Effect.map(
              ([mergeability, checks, changedFiles, canWrite]): ProviderChangeRequestDetail => ({
                ...toChangeRequest(pullRequest),
                mergeability,
                changedFiles,
                body: pullRequest.body,
                mergedAt: pullRequest.state === "merged" ? pullRequest.closedAt : null,
                closedAt: pullRequest.closedAt,
                reviewers: pullRequest.reviewers,
                checks,
                // The host publishes no per-repository list of allowed strategies, so the three
                // it supports are all offered and one the repository forbids fails on merge.
                mergeCapabilities: { merge: true, squash: true, rebase: true },
                viewerPermissions: bitbucketServerViewerPermissions({ canWrite }),
              }),
            ),
          ),
        ),
        Effect.mapError(fail("getChangeRequest")),
      );
    },

    getChangeRequestActivity: (input) => {
      const target = { repository: input.repository, number: input.number };
      return api.getPullRequest(target).pipe(
        Effect.flatMap((pullRequest) =>
          Effect.all(
            [
              api
                .listActivities({ ...target, pullRequestUrl: pullRequest.url })
                .pipe(Effect.orElseSucceed(() => ({ comments: [], threads: [], truncated: true }))),
              api.listCommits(target).pipe(Effect.orElseSucceed(() => [])),
            ],
            { concurrency: 2 },
          ),
        ),
        Effect.mapError(fail("getChangeRequestActivity")),
        Effect.map(([activity, commits]): ProviderChangeRequestActivity => ({
          comments: activity.comments,
          commentCount: activity.comments.length,
          commentsTruncated: activity.truncated,
          reviewThreads: activity.threads,
          commits,
        })),
      );
    },

    getViewerPermissions: (input) =>
      api.getRepositoryPermission({ repository: input.repository }).pipe(
        Effect.mapError(fail("getViewerPermissions")),
        Effect.map((canWrite) => bitbucketServerViewerPermissions({ canWrite })),
      ),

    // `.diff` answers with the whole patch and pages nothing, so the first slice is the last.
    getDiff: (input) =>
      api
        .getPullRequestDiff({
          repository: input.repository,
          number: input.number,
          ...(input.commit === undefined ? {} : { commit: input.commit }),
        })
        .pipe(
          Effect.mapError(fail("getDiff")),
          Effect.map((diff) => ({ ...diff, nextCursor: null })),
        ),

    getDiffFileContents: (input) =>
      api
        .getDiffFileContents({
          repository: input.repository,
          number: input.number,
          ...(input.commit === undefined ? {} : { commit: input.commit }),
          changeType: input.changeType,
          oldPath: input.oldPath,
          newPath: input.newPath,
        })
        .pipe(Effect.mapError(fail("getDiffFileContents"))),

    runAction: () => unsupported("runAction"),
    comment: () => unsupported("comment"),
    submitReview: () => unsupported("submitReview"),
    listReviewerCandidates: () => unsupported("listReviewerCandidates"),
    setReviewerRequest: () => unsupported("setReviewerRequest"),
    replyToThread: () => unsupported("replyToThread"),
    setReaction: () => unsupported("setReaction"),
    setThreadResolution: () => unsupported("setThreadResolution"),
  };

  return provider;
});
