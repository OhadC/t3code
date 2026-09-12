import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as BitbucketServerApi from "../sourceControl/BitbucketServerApi.ts";
import * as BitbucketServerPullRequestApi from "./BitbucketServerPullRequestApi.ts";
import {
  bitbucketServerProviderFailure,
  bitbucketServerViewerPermissions,
  make,
} from "./BitbucketServerPullRequestProvider.ts";
import type { BitbucketServerPullRequest } from "./bitbucketServerPullRequestJson.ts";

const pullRequest: BitbucketServerPullRequest = {
  number: 2,
  version: 1,
  title: "Live verification PR",
  url: "https://bitbucket.example.com/users/ohcohen/repos/testing-repo/pull-requests/2",
  author: { login: "access-token-user/2/11754", name: "Access Token User", avatarUrl: null },
  headBranch: "feature/dc-live",
  headCommit: "5e8770617aea7591ffda6a0fbe82149cf9a739a8",
  headRepositoryNameWithOwner: "~OHCOHEN/testing-repo",
  baseBranch: "main",
  state: "open",
  isDraft: false,
  createdAt: "2026-09-12T19:52:29.816Z",
  updatedAt: "2026-09-12T20:30:12.563Z",
  closedAt: null,
  body: "Created by the adapter.",
  reviewers: [{ login: "ohcohen", name: "Cohen, Ohad", avatarUrl: null }],
  reviewRequestLogins: ["ohcohen"],
};

describe("getChangeRequest", () => {
  it.effect("composes the detail and hides merge from a token that can only read", () => {
    const listChecks = vi.fn<
      BitbucketServerPullRequestApi.BitbucketServerPullRequestApi["Service"]["listChecks"]
    >(() =>
      Effect.succeed([{ name: "CI", status: "success" as const, description: null, url: null }]),
    );
    const api = Layer.mock(BitbucketServerPullRequestApi.BitbucketServerPullRequestApi)({
      getPullRequest: () => Effect.succeed(pullRequest),
      getMergeability: () => Effect.succeed("conflicting" as const),
      listChecks,
      getChangedFileCount: () => Effect.succeed(3),
      getRepositoryPermission: () => Effect.succeed(false),
    });

    return Effect.gen(function* () {
      const provider = yield* make;
      const detail = yield* provider.getChangeRequest({
        cwd: "/repo",
        repository: "~OHCOHEN/testing-repo",
        host: "bitbucket.example.com",
        number: 2,
      });

      expect(detail).toMatchObject({
        number: 2,
        state: "open",
        mergeability: "conflicting",
        changedFiles: 3,
        body: "Created by the adapter.",
        reviewers: [{ login: "ohcohen" }],
        checks: [{ name: "CI", status: "success" }],
        viewerPermissions: { actions: ["close", "reopen"] },
      });
      // Build statuses live on the head commit, which is the one the detail asks about.
      assert.strictEqual(
        listChecks.mock.calls[0]?.[0].commit,
        "5e8770617aea7591ffda6a0fbe82149cf9a739a8",
      );
    }).pipe(Effect.provide(api));
  });

  it.effect("grants merge when the permission could not be read at all", () => {
    const api = Layer.mock(BitbucketServerPullRequestApi.BitbucketServerPullRequestApi)({
      getPullRequest: () => Effect.succeed(pullRequest),
      getMergeability: () => Effect.succeed("mergeable" as const),
      listChecks: () => Effect.succeed([]),
      getChangedFileCount: () => Effect.succeed(1),
      getRepositoryPermission: () =>
        Effect.fail(
          new BitbucketServerApi.BitbucketServerResponseError({
            operation: "request",
            status: 500,
            responseBodyLength: 0,
          }),
        ),
    });

    return Effect.gen(function* () {
      const provider = yield* make;
      const detail = yield* provider.getChangeRequest({
        cwd: "/repo",
        repository: "~OHCOHEN/testing-repo",
        host: "bitbucket.example.com",
        number: 2,
      });

      // An unknown permission is granted rather than guessed away; the host's own refusal on
      // merge says why if the account may not.
      expect(detail.viewerPermissions.actions).toEqual(["merge", "close", "reopen"]);
    }).pipe(Effect.provide(api));
  });
});

describe("bitbucketServerProviderFailure", () => {
  const responseError = (status: number, retryAt?: number) =>
    new BitbucketServerApi.BitbucketServerResponseError({
      operation: "request",
      status,
      responseBodyLength: 0,
      ...(retryAt === undefined ? {} : { retryAt }),
    });

  it("treats a refused token and missing configuration as unusable credentials", () => {
    expect(bitbucketServerProviderFailure(responseError(401)).reason).toBe("unauthenticated");
    expect(
      bitbucketServerProviderFailure(new BitbucketServerApi.BitbucketServerNotConfiguredError())
        .reason,
    ).toBe("unauthenticated");
    expect(
      bitbucketServerProviderFailure(
        new BitbucketServerPullRequestApi.BitbucketServerViewerUnavailableError({
          reason: "unauthenticated",
          detail: "rejected",
        }),
      ).reason,
    ).toBe("unauthenticated");
  });

  it("pauses the host on a 429, carrying the retry instant", () => {
    expect(bitbucketServerProviderFailure(responseError(429, 1_000))).toEqual({
      reason: "rate-limited",
      retryAt: 1_000,
    });
  });

  it("treats anything else as one failed request", () => {
    expect(bitbucketServerProviderFailure(responseError(403)).reason).toBe("failed");
    expect(
      bitbucketServerProviderFailure(
        new BitbucketServerApi.BitbucketServerHostMismatchError({
          remoteHost: "bitbucket.other.com",
          configuredHost: "bitbucket.example.com",
        }),
      ).reason,
    ).toBe("failed");
  });
});

describe("bitbucketServerViewerPermissions", () => {
  it("offers every action to a token with write access", () => {
    expect(bitbucketServerViewerPermissions({ canWrite: true })).toEqual({
      actions: ["merge", "close", "reopen"],
      comment: true,
      resolve: false,
      verdicts: ["comment", "approve", "request-changes"],
      requestReviewers: true,
    });
  });

  it("keeps merge from a token that can only read the repository", () => {
    // Declining and reopening stay: an author may do both with read access, and the permission
    // read says nothing about who opened this pull request.
    expect(bitbucketServerViewerPermissions({ canWrite: false }).actions).toEqual([
      "close",
      "reopen",
    ]);
  });
});
