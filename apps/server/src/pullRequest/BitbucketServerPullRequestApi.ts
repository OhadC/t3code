import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type {
  PullRequestCheck,
  PullRequestComment,
  PullRequestCommit,
  PullRequestInvolvement,
  PullRequestListState,
  PullRequestMergeability,
  PullRequestReviewThread,
} from "@t3tools/contracts";

import * as BitbucketServerApi from "../sourceControl/BitbucketServerApi.ts";
import type { BitbucketServerRepositoryLocator } from "../sourceControl/bitbucketServerPullRequests.ts";
import {
  decodeActivitiesJson,
  decodeBuildStatusesJson,
  decodeCommitIdJson,
  decodeCommitParentJson,
  decodeChangesPageJson,
  decodeCommitsJson,
  decodeMergeCheckJson,
  decodePullRequestJson,
  decodePullRequestPageJson,
  decodeRepositoryPermissionJson,
  normalizeUnifiedDiff,
  type BitbucketServerPage,
  type BitbucketServerPullRequest,
} from "./bitbucketServerPullRequestJson.ts";
import type { ProviderListCursor } from "./PullRequestProvider.ts";

/**
 * Names the read that produced unusable output, so a failure reports the call it came from
 * rather than borrowing another operation's message.
 */
export class BitbucketServerPullRequestReadError extends Schema.TaggedError<BitbucketServerPullRequestReadError>()(
  "BitbucketServerPullRequestReadError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return `Bitbucket Data Center returned an unreadable ${this.operation} response.`;
  }

  override get message(): string {
    return `Bitbucket Data Center failed in ${this.operation}: ${this.detail}`;
  }
}

/**
 * The auth probe could not name an account. `unauthenticated` is the host or the configuration
 * refusing the token; `unknown` is the host being unreachable or answering without a name.
 */
export class BitbucketServerViewerUnavailableError extends Schema.TaggedError<BitbucketServerViewerUnavailableError>()(
  "BitbucketServerViewerUnavailableError",
  {
    reason: Schema.Literals(["unauthenticated", "unknown"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Bitbucket Data Center failed in getViewer: ${this.detail}`;
  }
}

/** A repository that is not `PROJECTKEY/repo-slug`, which is the only form Data Center addresses. */
export class BitbucketServerRepositoryUnsupportedError extends Schema.TaggedError<BitbucketServerRepositoryUnsupportedError>()(
  "BitbucketServerRepositoryUnsupportedError",
  {
    repository: Schema.String,
  },
) {
  get detail(): string {
    return "A Bitbucket Data Center repository is addressed as PROJECTKEY/repo-slug.";
  }

  override get message(): string {
    return `Bitbucket Data Center failed in resolveRepository: ${this.detail}`;
  }
}

/** Not a decode failure: the reader named a commit that is not a sha this repository could hold. */
export class BitbucketServerCommitShaError extends Schema.TaggedError<BitbucketServerCommitShaError>()(
  "BitbucketServerCommitShaError",
  {},
) {
  get detail(): string {
    return "The named commit was not a commit sha.";
  }

  override get message(): string {
    return `Bitbucket Data Center refused the request: ${this.detail}`;
  }
}

export type BitbucketServerPullRequestApiError =
  | BitbucketServerApi.BitbucketServerApiError
  | BitbucketServerPullRequestReadError
  | BitbucketServerViewerUnavailableError
  | BitbucketServerRepositoryUnsupportedError
  | BitbucketServerCommitShaError;

const API_ROOT = "/rest/api/1.0";
const BUILD_STATUS_ROOT = "/rest/build-status/1.0";
/** Data Center's own ceiling for a page. */
const MAX_PAGE_SIZE = 100;
/** Pages to walk before a listing is reported as truncated. */
const MAX_LIST_PAGES = 10;
/** Pages of the conversation, commits or checks to follow before reporting them as cut short. */
const CONVERSATION_PAGES = 10;
/** The same ceiling the other hosts' diff reads use. */
const DIFF_MAX_BYTES = 8 * 1024 * 1024;

export interface BitbucketServerPullRequestBatch {
  readonly items: ReadonlyArray<BitbucketServerPullRequest>;
  readonly truncated: boolean;
  /** Raw rows consumed for the items handed over, which an offset cursor has to count. */
  readonly cursorAdvance: number;
}

export class BitbucketServerPullRequestApi extends Context.Service<
  BitbucketServerPullRequestApi,
  {
    /** The token's account name, which is also the login the host writes on its own rows. */
    readonly getViewer: () => Effect.Effect<string, BitbucketServerPullRequestApiError>;

    readonly listPullRequests: (input: {
      readonly repository: string;
      readonly state: PullRequestListState;
      readonly involvement: PullRequestInvolvement;
      readonly viewer: string;
      readonly limit: number;
      /** Free text the host matches against title and description. */
      readonly query?: string | undefined;
      /** Where to carry on from, which for an offset-paged host is how many rows to skip. */
      readonly cursor?: ProviderListCursor | undefined;
    }) => Effect.Effect<BitbucketServerPullRequestBatch, BitbucketServerPullRequestApiError>;

    readonly getPullRequest: (input: {
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<BitbucketServerPullRequest, BitbucketServerPullRequestApiError>;

    /** True where the token can write to the repository, which is what merging needs. */
    readonly getRepositoryPermission: (input: {
      readonly repository: string;
    }) => Effect.Effect<boolean, BitbucketServerPullRequestApiError>;

    readonly getMergeability: (input: {
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<PullRequestMergeability, BitbucketServerPullRequestApiError>;

    /** Build statuses on one commit, which is where Data Center keeps them. */
    readonly listChecks: (input: {
      readonly commit: string;
    }) => Effect.Effect<ReadonlyArray<PullRequestCheck>, BitbucketServerPullRequestApiError>;

    readonly listActivities: (input: {
      readonly repository: string;
      readonly number: number;
      readonly pullRequestUrl: string;
    }) => Effect.Effect<
      {
        readonly comments: ReadonlyArray<PullRequestComment>;
        readonly threads: ReadonlyArray<PullRequestReviewThread>;
        readonly truncated: boolean;
      },
      BitbucketServerPullRequestApiError
    >;

    readonly listCommits: (input: {
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<ReadonlyArray<PullRequestCommit>, BitbucketServerPullRequestApiError>;

    readonly getPullRequestDiff: (input: {
      readonly repository: string;
      readonly number: number;
      /** One commit's own changes, rather than everything the pull request carries. */
      readonly commit?: string | undefined;
    }) => Effect.Effect<
      { readonly patch: string; readonly truncated: boolean },
      BitbucketServerPullRequestApiError
    >;

    /** How many files the pull request touches; the host states no line counts anywhere. */
    readonly getChangedFileCount: (input: {
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<number, BitbucketServerPullRequestApiError>;

    readonly getDiffFileContents: (input: {
      readonly repository: string;
      readonly number: number;
      readonly commit?: string | undefined;
      readonly changeType: "change" | "rename-pure" | "rename-changed" | "new" | "deleted";
      readonly oldPath: string;
      readonly newPath: string;
    }) => Effect.Effect<
      { readonly oldContents: string; readonly newContents: string },
      BitbucketServerPullRequestApiError
    >;
  }
>()("t3/pullRequest/BitbucketServerPullRequestApi") {}

function repositoryPathOf(locator: BitbucketServerRepositoryLocator): string {
  return `${API_ROOT}/projects/${encodeURIComponent(locator.projectKey)}/repos/${encodeURIComponent(
    locator.repoSlug,
  )}`;
}

/** Each path segment encoded on its own, so the slashes still address directories. */
function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/**
 * A commit sha arrives from the reader and goes straight into a request path, so it is checked
 * rather than trusted.
 */
function isCommitSha(value: string): boolean {
  return /^[0-9a-f]{7,64}$/i.test(value);
}

function stateParam(state: PullRequestListState): string {
  switch (state) {
    case "open":
      return "OPEN";
    case "merged":
      return "MERGED";
    case "closed":
      return "DECLINED";
    case "all":
      return "ALL";
  }
}

/** The host narrows by a participant's role; `role.1`/`username.1` are one such pair. */
function involvementParams(
  involvement: PullRequestInvolvement,
  viewer: string,
): Array<[string, string]> {
  switch (involvement) {
    case "authored":
      return [
        ["role.1", "AUTHOR"],
        ["username.1", viewer],
      ];
    case "reviewing":
      return [
        ["role.1", "REVIEWER"],
        ["username.1", viewer],
      ];
    case "all":
      return [];
  }
}

function withStart(url: string, start: number): string {
  return `${url}${url.includes("?") ? "&" : "?"}start=${start}`;
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const bitbucket = yield* BitbucketServerApi.BitbucketServerApi;

  const withRepository = <A>(
    repository: string,
    use: (
      path: string,
      locator: BitbucketServerRepositoryLocator,
    ) => Effect.Effect<A, BitbucketServerPullRequestApiError>,
  ): Effect.Effect<A, BitbucketServerPullRequestApiError> => {
    const locator = BitbucketServerApi.parseRepositoryName(repository);
    return locator === null
      ? Effect.fail(new BitbucketServerRepositoryUnsupportedError({ repository }))
      : use(repositoryPathOf(locator), locator);
  };

  const read = <A>(input: {
    readonly operation: string;
    readonly url: string;
    readonly decode: (body: string) => Result.Result<A, unknown>;
  }): Effect.Effect<A, BitbucketServerPullRequestApiError> =>
    bitbucket.request({ method: "GET", url: input.url }).pipe(
      Effect.flatMap((response) => {
        const decoded = input.decode(response.body);
        return Result.isSuccess(decoded)
          ? Effect.succeed(decoded.success)
          : Effect.fail(
              new BitbucketServerPullRequestReadError({
                operation: input.operation,
                cause: decoded.failure,
              }),
            );
      }),
    );

  /**
   * Walks an offset-paged collection to its end or to the page cap, whichever comes first.
   * Anything but running out of pages means there is more to be had.
   */
  const readAllPages = <A>(input: {
    readonly operation: string;
    readonly url: string;
    readonly decode: (body: string) => Result.Result<BitbucketServerPage<A>, unknown>;
    readonly maxPages: number;
  }): Effect.Effect<
    { readonly items: ReadonlyArray<A>; readonly truncated: boolean },
    BitbucketServerPullRequestApiError
  > =>
    Effect.gen(function* () {
      const items: A[] = [];
      let start = 0;
      for (let page = 1; page <= input.maxPages; page += 1) {
        const decoded = yield* read({
          operation: input.operation,
          url: withStart(input.url, start),
          decode: input.decode,
        });
        items.push(...decoded.items);
        if (decoded.nextPageStart === null) return { items, truncated: false };
        start = decoded.nextPageStart;
      }
      return { items, truncated: true };
    });

  const getPullRequest = (path: string, number: number) =>
    read({
      operation: "getPullRequest",
      url: `${path}/pull-requests/${number}`,
      decode: decodePullRequestJson,
    });

  const getPullRequestDiff: BitbucketServerPullRequestApi["Service"]["getPullRequestDiff"] = (
    input,
  ) =>
    input.commit !== undefined && !isCommitSha(input.commit)
      ? Effect.fail(new BitbucketServerCommitShaError())
      : withRepository(input.repository, (path) =>
          bitbucket
            .request(
              // `.diff` is the pull request's own raw patch. A commit's has no raw spelling of
              // its own, but its JSON endpoint answers with the same patch when asked for text.
              input.commit === undefined
                ? {
                    method: "GET",
                    url: `${path}/pull-requests/${input.number}.diff`,
                    maxBytes: DIFF_MAX_BYTES,
                  }
                : {
                    method: "GET",
                    url: `${path}/commits/${input.commit}/diff`,
                    accept: "text/plain",
                    maxBytes: DIFF_MAX_BYTES,
                  },
            )
            .pipe(
              Effect.map((response) => ({
                patch: normalizeUnifiedDiff(response.body),
                truncated: response.truncated,
              })),
            ),
        );

  /**
   * The revisions either side of the patch: the merge base and the source tip for the pull
   * request, or a commit's first parent and itself. Null on the old side where there is no
   * commit there, which is a root commit.
   */
  const diffRevisions = (input: {
    readonly path: string;
    readonly number: number;
    readonly commit: string | undefined;
  }): Effect.Effect<
    { readonly oldCommit: string | null; readonly newCommit: string },
    BitbucketServerPullRequestApiError
  > => {
    const commit = input.commit;
    return commit === undefined
      ? Effect.all(
          [
            getPullRequest(input.path, input.number),
            read({
              operation: "getMergeBase",
              url: `${input.path}/pull-requests/${input.number}/merge-base`,
              decode: decodeCommitIdJson,
            }),
          ],
          { concurrency: 2 },
        ).pipe(
          Effect.flatMap(([pullRequest, mergeBase]) =>
            pullRequest.headCommit === null
              ? Effect.fail(
                  new BitbucketServerPullRequestReadError({
                    operation: "getPullRequest",
                    cause: new Error("The pull request named no source commit."),
                  }),
                )
              : Effect.succeed({ oldCommit: mergeBase, newCommit: pullRequest.headCommit }),
          ),
        )
      : read({
          operation: "getCommit",
          url: `${input.path}/commits/${commit}`,
          decode: decodeCommitParentJson,
        }).pipe(Effect.map((parent) => ({ oldCommit: parent, newCommit: commit })));
  };

  const rawFile = (path: string, filePath: string, commit: string) =>
    bitbucket
      .request({
        method: "GET",
        url: `${path}/raw/${encodePath(filePath)}?at=${encodeURIComponent(commit)}`,
        maxBytes: DIFF_MAX_BYTES,
      })
      .pipe(Effect.map((response) => response.body));

  return BitbucketServerPullRequestApi.of({
    // The probe is the one request whose answer carries the account: Data Center names the
    // caller in a response header rather than at any endpoint of its own.
    getViewer: () =>
      bitbucket.probeAuth.pipe(
        Effect.flatMap((auth) => {
          const detail = Option.getOrElse(
            auth.detail,
            () => "Bitbucket Data Center did not name the configured token's account.",
          );
          if (auth.status === "unauthenticated") {
            return Effect.fail(
              new BitbucketServerViewerUnavailableError({ reason: "unauthenticated", detail }),
            );
          }
          return Option.match(auth.status === "authenticated" ? auth.account : Option.none(), {
            onNone: () =>
              Effect.fail(new BitbucketServerViewerUnavailableError({ reason: "unknown", detail })),
            onSome: Effect.succeed,
          });
        }),
      ),

    listPullRequests: (input) =>
      withRepository(input.repository, (path) =>
        Effect.gen(function* () {
          const params = new URLSearchParams([
            ["state", stateParam(input.state)] as [string, string],
            ["order", "NEWEST"],
            ...involvementParams(input.involvement, input.viewer),
          ]);
          const search = input.query?.trim() ?? "";
          if (search.length > 0) params.set("filterText", search);

          const collected: BitbucketServerPullRequest[] = [];
          let start = input.cursor?.delivered ?? 0;
          let cursorAdvance = 0;
          for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
            // Only the rows still wanted are asked for, so a page is never read to be dropped,
            // and every raw row it holds — malformed ones included — is one the cursor steps past.
            const room = input.limit - collected.length;
            params.set("limit", String(Math.min(room, MAX_PAGE_SIZE)));
            params.set("start", String(start));
            const decoded = yield* read({
              operation: "listPullRequests",
              url: `${path}/pull-requests?${params.toString()}`,
              decode: decodePullRequestPageJson,
            });
            if (decoded.items.length > room) {
              // The host answered with more than was asked for. The rows kept are the advance:
              // the ones dropped are still to come, and the next cursor must land on them.
              collected.push(...decoded.items.slice(0, room));
              return { items: collected, truncated: true, cursorAdvance: cursorAdvance + room };
            }
            collected.push(...decoded.items);
            cursorAdvance += decoded.rawCount;
            if (decoded.nextPageStart === null) {
              return { items: collected, truncated: false, cursorAdvance };
            }
            if (collected.length >= input.limit) {
              return { items: collected, truncated: true, cursorAdvance };
            }
            start = decoded.nextPageStart;
          }
          return { items: collected, truncated: true, cursorAdvance };
        }),
      ),

    getPullRequest: (input) =>
      withRepository(input.repository, (path) => getPullRequest(path, input.number)),

    // Nothing on the repository or the pull request states what the token may do, but the
    // repository search takes a permission to narrow by, and answers with the repositories the
    // caller holds at least that permission on. The name filter is a substring across every
    // project, so the pages are walked until this repository turns up or they run out.
    getRepositoryPermission: (input) =>
      withRepository(input.repository, (_, locator) =>
        Effect.gen(function* () {
          const url = `${API_ROOT}/repos?${new URLSearchParams([
            ["name", locator.repoSlug],
            ["permission", "REPO_WRITE"],
            ["limit", String(MAX_PAGE_SIZE)],
          ]).toString()}`;
          let start = 0;
          for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
            const decoded = yield* read({
              operation: "getRepositoryPermission",
              url: withStart(url, start),
              decode: (body) => decodeRepositoryPermissionJson(body, locator),
            });
            if (decoded.granted) return true;
            if (decoded.nextPageStart === null) return false;
            start = decoded.nextPageStart;
          }
          return false;
        }),
      ),

    getMergeability: (input) =>
      withRepository(input.repository, (path) =>
        read({
          operation: "getMergeability",
          url: `${path}/pull-requests/${input.number}/merge`,
          decode: decodeMergeCheckJson,
        }),
      ),

    listChecks: (input) =>
      isCommitSha(input.commit)
        ? readAllPages({
            operation: "listChecks",
            url: `${BUILD_STATUS_ROOT}/commits/${input.commit}?limit=${MAX_PAGE_SIZE}`,
            decode: decodeBuildStatusesJson,
            maxPages: CONVERSATION_PAGES,
          }).pipe(Effect.map((page) => page.items))
        : Effect.fail(new BitbucketServerCommitShaError()),

    listActivities: (input) =>
      withRepository(input.repository, (path) =>
        readAllPages({
          operation: "listActivities",
          url: `${path}/pull-requests/${input.number}/activities?limit=${MAX_PAGE_SIZE}`,
          decode: (body) => decodeActivitiesJson(body, input.pullRequestUrl),
          maxPages: CONVERSATION_PAGES,
        }).pipe(
          Effect.map((page) => ({
            comments: page.items
              .flatMap((activity) => activity.comments)
              .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)),
            threads: page.items.flatMap((activity) => activity.threads),
            truncated: page.truncated,
          })),
        ),
      ),

    // The host lists a pull request's commits newest first; the timeline reads oldest first.
    listCommits: (input) =>
      withRepository(input.repository, (path) =>
        readAllPages({
          operation: "listCommits",
          url: `${path}/pull-requests/${input.number}/commits?limit=${MAX_PAGE_SIZE}`,
          decode: decodeCommitsJson,
          maxPages: CONVERSATION_PAGES,
        }).pipe(Effect.map((page) => page.items.toReversed())),
      ),

    getPullRequestDiff,

    getChangedFileCount: (input) =>
      withRepository(input.repository, (path) =>
        Effect.gen(function* () {
          const url = `${path}/pull-requests/${input.number}/changes?limit=${MAX_PAGE_SIZE}`;
          let count = 0;
          let start = 0;
          for (let page = 1; page <= CONVERSATION_PAGES; page += 1) {
            const decoded = yield* read({
              operation: "getChangedFileCount",
              url: withStart(url, start),
              decode: decodeChangesPageJson,
            });
            count += decoded.count;
            if (decoded.nextPageStart === null) break;
            start = decoded.nextPageStart;
          }
          return count;
        }),
      ),

    getDiffFileContents: (input) =>
      input.commit !== undefined && !isCommitSha(input.commit)
        ? Effect.fail(new BitbucketServerCommitShaError())
        : withRepository(input.repository, (path) =>
            diffRevisions({ path, number: input.number, commit: input.commit }).pipe(
              Effect.flatMap(({ oldCommit, newCommit }) =>
                Effect.all(
                  [
                    input.changeType === "new" || oldCommit === null
                      ? Effect.succeed("")
                      : rawFile(path, input.oldPath, oldCommit),
                    input.changeType === "deleted"
                      ? Effect.succeed("")
                      : rawFile(path, input.newPath, newCommit),
                  ],
                  { concurrency: 2 },
                ),
              ),
              Effect.map(([oldContents, newContents]) => ({ oldContents, newContents })),
            ),
          ),
  });
});

export const layer = Layer.effect(BitbucketServerPullRequestApi, make);
