import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  NonNegativeInt,
  TrimmedNonEmptyString,
  type SourceControlProviderAuth,
  type SourceControlRepositoryCloneUrls,
} from "@t3tools/contracts";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { sanitizeBranchFragment } from "@t3tools/shared/git";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import { detectSourceControlProviderFromRemoteUrl } from "@t3tools/shared/sourceControl";

import {
  normalizeBitbucketChangeRequestId,
  type NormalizedBitbucketPullRequestRecord,
} from "./bitbucketPullRequests.ts";
import {
  BitbucketServerPullRequestPageSchema,
  BitbucketServerPullRequestSchema,
  BitbucketServerRepositoryRefSchema,
  bitbucketServerRepositoryName,
  normalizeBitbucketServerPullRequestRecord,
  type BitbucketServerRepositoryLocator,
} from "./bitbucketServerPullRequests.ts";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import { retryAtFromHeader } from "./SourceControlRateLimit.ts";

export const CONFIGURATION_HINT =
  "Set T3CODE_BITBUCKET_SERVER_URL and T3CODE_BITBUCKET_SERVER_TOKEN on the server (use an HTTP access token with repository read/write and project read scopes).";

const API_ROOT = "/rest/api/1.0";
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_PAGE_SIZE = 100;
const MAX_LIST_PAGES = 10;

const BitbucketServerEnvConfig = Config.all({
  baseUrl: Config.String("T3CODE_BITBUCKET_SERVER_URL").pipe(Config.option),
  token: Config.String("T3CODE_BITBUCKET_SERVER_TOKEN").pipe(Config.option),
});

const BitbucketServerApiOperation = Schema.Literals([
  "resolveRepository",
  "getRepository",
  "getDefaultBranch",
  "getPullRequest",
  "listPullRequests",
  "createPullRequest",
  "probeAuth",
  "checkoutPullRequest",
  "request",
]);
type BitbucketServerApiOperation = typeof BitbucketServerApiOperation.Type;

export class BitbucketServerNotConfiguredError extends Schema.TaggedError<BitbucketServerNotConfiguredError>()(
  "BitbucketServerNotConfiguredError",
  {},
) {
  get detail(): string {
    return CONFIGURATION_HINT;
  }

  override get message(): string {
    return `Bitbucket Data Center is not configured: ${this.detail}`;
  }
}

export class BitbucketServerHostMismatchError extends Schema.TaggedError<BitbucketServerHostMismatchError>()(
  "BitbucketServerHostMismatchError",
  {
    remoteHost: Schema.String,
    configuredHost: Schema.String,
  },
) {
  get detail(): string {
    return `The remote is on ${this.remoteHost} but T3CODE_BITBUCKET_SERVER_URL points at ${this.configuredHost}.`;
  }

  override get message(): string {
    return `Bitbucket Data Center API failed in resolveRepository: ${this.detail}`;
  }
}

export class BitbucketServerRepositoryLocatorError extends Schema.TaggedError<BitbucketServerRepositoryLocatorError>()(
  "BitbucketServerRepositoryLocatorError",
  {
    repository: Schema.String,
  },
) {
  get detail(): string {
    return "Bitbucket Data Center repositories must be specified as PROJECTKEY/repo-slug.";
  }

  override get message(): string {
    return `Bitbucket Data Center API failed in resolveRepository: ${this.detail}`;
  }
}

export class BitbucketServerRequestError extends Schema.TaggedError<BitbucketServerRequestError>()(
  "BitbucketServerRequestError",
  {
    operation: BitbucketServerApiOperation,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return "Failed to send the Bitbucket Data Center request.";
  }

  override get message(): string {
    return `Bitbucket Data Center API failed in ${this.operation}: ${this.detail}`;
  }
}

export class BitbucketServerResponseError extends Schema.TaggedError<BitbucketServerResponseError>()(
  "BitbucketServerResponseError",
  {
    operation: BitbucketServerApiOperation,
    status: Schema.Int,
    responseBodyLength: NonNegativeInt,
    retryAt: Schema.optional(Schema.Number),
    /**
     * What the host said was wrong, out of its structured `errors` list — a disabled merge
     * strategy, a stale version, a missing e-mail. Nothing else of the body is carried.
     */
    hostMessage: Schema.optional(Schema.String),
  },
) {
  get detail(): string {
    return this.hostMessage === undefined
      ? `Bitbucket Data Center returned HTTP ${this.status}.`
      : `Bitbucket Data Center returned HTTP ${this.status}: ${this.hostMessage}`;
  }

  override get message(): string {
    return `Bitbucket Data Center API failed in ${this.operation}: ${this.detail}`;
  }
}

export class BitbucketServerResponseBodyReadError extends Schema.TaggedError<BitbucketServerResponseBodyReadError>()(
  "BitbucketServerResponseBodyReadError",
  {
    operation: BitbucketServerApiOperation,
    status: Schema.Int,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return `Bitbucket Data Center returned HTTP ${this.status}.`;
  }

  override get message(): string {
    return `Bitbucket Data Center API failed in ${this.operation}: ${this.detail}`;
  }
}

export class BitbucketServerResponseDecodeError extends Schema.TaggedError<BitbucketServerResponseDecodeError>()(
  "BitbucketServerResponseDecodeError",
  {
    operation: BitbucketServerApiOperation,
    status: Schema.Int,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return "Bitbucket Data Center returned invalid JSON for the requested resource.";
  }

  override get message(): string {
    return `Bitbucket Data Center API failed in ${this.operation}: ${this.detail}`;
  }
}

export class BitbucketServerRepositoryRemotesError extends Schema.TaggedError<BitbucketServerRepositoryRemotesError>()(
  "BitbucketServerRepositoryRemotesError",
  {
    cwd: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return `Failed to list remotes for ${this.cwd}.`;
  }

  override get message(): string {
    return `Bitbucket Data Center API failed in resolveRepository: ${this.detail}`;
  }
}

export class BitbucketServerRepositoryRemoteNotFoundError extends Schema.TaggedError<BitbucketServerRepositoryRemoteNotFoundError>()(
  "BitbucketServerRepositoryRemoteNotFoundError",
  {
    cwd: Schema.String,
  },
) {
  get detail(): string {
    return `No Bitbucket Data Center repository remote was detected for ${this.cwd}.`;
  }

  override get message(): string {
    return `Bitbucket Data Center API failed in resolveRepository: ${this.detail}`;
  }
}

export class BitbucketServerPullRequestBodyReadError extends Schema.TaggedError<BitbucketServerPullRequestBodyReadError>()(
  "BitbucketServerPullRequestBodyReadError",
  {
    cwd: Schema.String,
    bodyFile: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return `Failed to read pull request body file ${this.bodyFile}.`;
  }

  override get message(): string {
    return `Bitbucket Data Center API failed in createPullRequest: ${this.detail}`;
  }
}

export class BitbucketServerCheckoutError extends Schema.TaggedError<BitbucketServerCheckoutError>()(
  "BitbucketServerCheckoutError",
  {
    cwd: Schema.String,
    reference: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return "Failed to check out the Bitbucket Data Center pull request.";
  }

  override get message(): string {
    return `Bitbucket Data Center API failed in checkoutPullRequest: ${this.detail}`;
  }
}

export class BitbucketServerUntrustedUrlError extends Schema.TaggedError<BitbucketServerUntrustedUrlError>()(
  "BitbucketServerUntrustedUrlError",
  {
    host: Schema.String,
  },
) {
  get detail(): string {
    return `The url pointed at ${this.host}, outside the configured Bitbucket Data Center.`;
  }

  override get message(): string {
    return `Bitbucket Data Center API failed in request: ${this.detail}`;
  }
}

export const BitbucketServerApiError = Schema.Union([
  BitbucketServerNotConfiguredError,
  BitbucketServerHostMismatchError,
  BitbucketServerRepositoryLocatorError,
  BitbucketServerRequestError,
  BitbucketServerResponseError,
  BitbucketServerResponseBodyReadError,
  BitbucketServerResponseDecodeError,
  BitbucketServerRepositoryRemotesError,
  BitbucketServerRepositoryRemoteNotFoundError,
  BitbucketServerPullRequestBodyReadError,
  BitbucketServerCheckoutError,
  BitbucketServerUntrustedUrlError,
]);
export type BitbucketServerApiError = typeof BitbucketServerApiError.Type;
const isBitbucketServerApiError = Schema.is(BitbucketServerApiError);

const RawBitbucketServerRepositorySchema = Schema.Struct({
  ...BitbucketServerRepositoryRefSchema.fields,
  links: Schema.Struct({
    clone: Schema.optional(
      Schema.Array(
        Schema.Struct({
          name: TrimmedNonEmptyString,
          href: TrimmedNonEmptyString,
        }),
      ),
    ),
    self: Schema.optional(
      Schema.Array(
        Schema.Struct({
          href: TrimmedNonEmptyString,
        }),
      ),
    ),
  }),
});

const RawBitbucketServerDefaultBranchSchema = Schema.Struct({
  displayId: TrimmedNonEmptyString,
});

export class BitbucketServerApi extends Context.Service<
  BitbucketServerApi,
  {
    readonly probeAuth: Effect.Effect<SourceControlProviderAuth, never>;

    readonly request: (input: {
      readonly method: "GET" | "POST" | "PUT" | "DELETE";
      readonly url: string;
      readonly body?: string;
      /** A media type to ask for, where an endpoint answers JSON unless told otherwise. */
      readonly accept?: string;
      readonly maxBytes?: number;
    }) => Effect.Effect<
      { readonly body: string; readonly truncated: boolean },
      BitbucketServerApiError
    >;
    readonly listPullRequests: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
      readonly headSelector: string;
      readonly source?: SourceControlProvider.SourceControlRefSelector;
      readonly state: "open" | "closed" | "merged" | "all";
      readonly limit?: number;
    }) => Effect.Effect<
      ReadonlyArray<NormalizedBitbucketPullRequestRecord>,
      BitbucketServerApiError
    >;
    readonly getPullRequest: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
      readonly reference: string;
    }) => Effect.Effect<NormalizedBitbucketPullRequestRecord, BitbucketServerApiError>;
    readonly getRepositoryCloneUrls: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
      readonly repository: string;
    }) => Effect.Effect<SourceControlRepositoryCloneUrls, BitbucketServerApiError>;
    readonly createPullRequest: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
      readonly baseBranch: string;
      readonly headSelector: string;
      readonly source?: SourceControlProvider.SourceControlRefSelector;
      readonly target?: SourceControlProvider.SourceControlRefSelector;
      readonly title: string;
      readonly bodyFile: string;
    }) => Effect.Effect<NormalizedBitbucketPullRequestRecord, BitbucketServerApiError>;
    readonly getDefaultBranch: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
    }) => Effect.Effect<string | null, BitbucketServerApiError>;
    readonly checkoutPullRequest: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
      readonly reference: string;
      readonly force?: boolean;
    }) => Effect.Effect<void, BitbucketServerApiError>;
  }
>()("t3/sourceControl/BitbucketServerApi") {}

interface BitbucketServerConnection {
  readonly baseUrl: string;
  readonly origin: string;
  readonly hostname: string;
  readonly token: string;
}

function nonEmpty(value: string | undefined): Option.Option<string> {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? Option.none() : Option.some(trimmed);
}

function connectionFromConfig(
  config: Config.Success<typeof BitbucketServerEnvConfig>,
): Option.Option<BitbucketServerConnection> {
  const baseUrl = Option.flatMap(config.baseUrl, nonEmpty);
  const token = Option.flatMap(config.token, nonEmpty);
  if (Option.isNone(baseUrl) || Option.isNone(token)) return Option.none();
  let url: URL;
  try {
    url = new URL(baseUrl.value);
  } catch {
    return Option.none();
  }
  return Option.some({
    baseUrl: `${url.origin}${url.pathname.replace(/\/+$/u, "")}`,
    origin: url.origin,
    hostname: url.hostname.toLowerCase(),
    token: token.value,
  });
}

/** `PROJECTKEY/repo-slug`, the last two segments of whatever spelling arrived. */
export function parseRepositoryName(value: string): BitbucketServerRepositoryLocator | null {
  const normalized = value.trim().replace(/\.git$/u, "");
  const parts = normalized.split("/").filter((part) => part.length > 0);
  const projectKey = parts.at(-2);
  const repoSlug = parts.at(-1);
  return parts.length >= 2 && projectKey && repoSlug ? { projectKey, repoSlug } : null;
}

function parseRemoteUrl(remoteUrl: string): BitbucketServerRepositoryLocator | null {
  const trimmed = remoteUrl.trim();
  const scpMatch = /^[a-zA-Z0-9._-]+@[^:/]+:(.+)$/.exec(trimmed);
  if (scpMatch?.[1]) return parseRepositoryName(scpMatch[1]);
  try {
    return parseRepositoryName(new URL(trimmed).pathname);
  } catch {
    return null;
  }
}

function remoteHostname(remoteUrl: string): string | null {
  const detected = detectSourceControlProviderFromRemoteUrl(remoteUrl);
  if (!detected) return null;
  try {
    return new URL(detected.baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function toBitbucketServerState(state: "open" | "closed" | "merged" | "all"): string {
  switch (state) {
    case "open":
      return "OPEN";
    case "closed":
      return "DECLINED";
    case "merged":
      return "MERGED";
    case "all":
      return "ALL";
  }
}

function sourceOwner(input: {
  readonly headSelector: string;
  readonly source?: SourceControlProvider.SourceControlRefSelector;
}): string | undefined {
  if (input.source?.owner) return input.source.owner;
  return SourceControlProvider.parseSourceControlOwnerRef(input.headSelector)?.owner;
}

function normalizeRepositoryCloneUrls(
  raw: typeof RawBitbucketServerRepositorySchema.Type,
): SourceControlRepositoryCloneUrls {
  const nameWithOwner = bitbucketServerRepositoryName({
    projectKey: raw.project.key,
    repoSlug: raw.slug,
  });
  const httpClone = raw.links.clone?.find((entry) => entry.name.toLowerCase() === "http")?.href;
  const sshClone = raw.links.clone?.find((entry) => entry.name.toLowerCase() === "ssh")?.href;
  const browseUrl = raw.links.self?.[0]?.href;
  return {
    nameWithOwner,
    url: httpClone ?? browseUrl ?? nameWithOwner,
    sshUrl: sshClone ?? httpClone ?? browseUrl ?? nameWithOwner,
  };
}

function checkoutBranchName(input: {
  readonly pullRequestId: number;
  readonly headBranch: string;
  readonly isCrossRepository: boolean;
}): string {
  return input.isCrossRepository
    ? `t3code/pr-${input.pullRequestId}/${sanitizeBranchFragment(input.headBranch)}`
    : input.headBranch;
}

function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function responseError(
  operation: BitbucketServerApiOperation,
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<never, BitbucketServerApiError> {
  return Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const collected = yield* collectUint8StreamText({
      stream: response.stream,
      maxBytes: DEFAULT_MAX_RESPONSE_BYTES,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new BitbucketServerResponseBodyReadError({
            operation,
            status: response.status,
            cause,
          }),
      ),
    );
    const hostMessage = hostErrorMessage(collected.text);
    return yield* new BitbucketServerResponseError({
      operation,
      status: response.status,
      responseBodyLength: collected.text.length,
      retryAt: retryAtFromHeader(response.headers["retry-after"], now),
      ...(hostMessage === null ? {} : { hostMessage }),
    });
  });
}

const HostErrorsSchema = Schema.Struct({
  errors: Schema.Array(Schema.Struct({ message: Schema.optional(Schema.NullOr(Schema.String)) })),
});
const decodeHostErrors = decodeJsonResult(HostErrorsSchema);
const HOST_MESSAGE_MAX_LENGTH = 500;

/** The host's own account of a refusal, or null where the body is not its `errors` document. */
function hostErrorMessage(body: string): string | null {
  const decoded = decodeHostErrors(body);
  if (!Result.isSuccess(decoded)) return null;
  const message = decoded.success.errors
    .flatMap((error) => {
      const text = error.message?.trim() ?? "";
      return text.length > 0 ? [text] : [];
    })
    .join(" ");
  return message.length === 0 ? null : message.slice(0, HOST_MESSAGE_MAX_LENGTH);
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* BitbucketServerEnvConfig;
  const httpClient = yield* HttpClient.HttpClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const connection = connectionFromConfig(config);

  const withConnection = <A, E, R>(
    use: (connection: BitbucketServerConnection) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | BitbucketServerNotConfiguredError, R> =>
    Option.match(connection, {
      onNone: () => Effect.fail(new BitbucketServerNotConfiguredError()),
      onSome: use,
    });

  const apiUrl = (connection: BitbucketServerConnection, path: string) =>
    `${connection.baseUrl}${API_ROOT}${path}`;

  const repositoryPath = (repository: BitbucketServerRepositoryLocator) =>
    `/projects/${encodeURIComponent(repository.projectKey)}/repos/${encodeURIComponent(repository.repoSlug)}`;

  const send = (
    operation: BitbucketServerApiOperation,
    connection: BitbucketServerConnection,
    request: HttpClientRequest.HttpClientRequest,
  ) =>
    httpClient
      .execute(request.pipe(HttpClientRequest.bearerToken(connection.token)))
      .pipe(
        Effect.mapError(
          (cause): BitbucketServerApiError => new BitbucketServerRequestError({ operation, cause }),
        ),
      );

  const decodeResponse = <S extends Schema.Top>(
    operation: BitbucketServerApiOperation,
    schema: S,
    response: HttpClientResponse.HttpClientResponse,
  ): Effect.Effect<S["Type"], BitbucketServerApiError, S["DecodingServices"]> =>
    HttpClientResponse.matchStatus({
      "2xx": (success) =>
        HttpClientResponse.schemaBodyJson(schema)(success).pipe(
          Effect.mapError(
            (cause) =>
              new BitbucketServerResponseDecodeError({
                operation,
                status: success.status,
                cause,
              }),
          ),
        ),
      orElse: (failed) => responseError(operation, failed),
    })(response);

  const executeJson = <S extends Schema.Top>(
    operation: BitbucketServerApiOperation,
    buildRequest: (connection: BitbucketServerConnection) => HttpClientRequest.HttpClientRequest,
    schema: S,
  ): Effect.Effect<S["Type"], BitbucketServerApiError, S["DecodingServices"]> =>
    withConnection((connection) =>
      send(operation, connection, buildRequest(connection).pipe(HttpClientRequest.acceptJson)).pipe(
        Effect.flatMap((response) => decodeResponse(operation, schema, response)),
      ),
    );

  const locatorFromRemote = (
    connection: BitbucketServerConnection,
    remoteUrl: string,
  ): Effect.Effect<BitbucketServerRepositoryLocator | null, BitbucketServerHostMismatchError> => {
    const hostname = remoteHostname(remoteUrl);
    if (hostname !== null && hostname !== connection.hostname) {
      return Effect.fail(
        new BitbucketServerHostMismatchError({
          remoteHost: hostname,
          configuredHost: connection.hostname,
        }),
      );
    }
    return Effect.succeed(parseRemoteUrl(remoteUrl));
  };

  const resolveRepository = Effect.fn("BitbucketServerApi.resolveRepository")(function* (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly repository?: string;
  }) {
    const connection = yield* withConnection(Effect.succeed);

    if (input.repository !== undefined) {
      const fromRepository = parseRepositoryName(input.repository);
      if (fromRepository) return fromRepository;
      return yield* new BitbucketServerRepositoryLocatorError({ repository: input.repository });
    }

    if (input.context?.provider.kind === "bitbucket-server") {
      const fromContext = yield* locatorFromRemote(connection, input.context.remoteUrl);
      if (fromContext) return fromContext;
    }

    const remotes = yield* vcsRegistry.resolve({ cwd: input.cwd }).pipe(
      Effect.flatMap((handle) => handle.driver.listRemotes(input.cwd)),
      Effect.mapError(
        (cause) => new BitbucketServerRepositoryRemotesError({ cwd: input.cwd, cause }),
      ),
    );
    for (const remote of remotes.remotes) {
      if (detectSourceControlProviderFromRemoteUrl(remote.url)?.kind !== "bitbucket-server") {
        continue;
      }
      const parsed = yield* locatorFromRemote(connection, remote.url);
      if (parsed) return parsed;
    }

    return yield* new BitbucketServerRepositoryRemoteNotFoundError({ cwd: input.cwd });
  });

  const getRepositoryFromLocator = (repository: BitbucketServerRepositoryLocator) =>
    executeJson(
      "getRepository",
      (connection) => HttpClientRequest.get(apiUrl(connection, repositoryPath(repository))),
      RawBitbucketServerRepositorySchema,
    );

  const getRawPullRequest = (repository: BitbucketServerRepositoryLocator, reference: string) =>
    executeJson(
      "getPullRequest",
      (connection) =>
        HttpClientRequest.get(
          apiUrl(
            connection,
            `${repositoryPath(repository)}/pull-requests/${encodeURIComponent(normalizeBitbucketChangeRequestId(reference))}`,
          ),
        ),
      BitbucketServerPullRequestSchema,
    );

  const listPullRequestPages = Effect.fn("BitbucketServerApi.listPullRequestPages")(
    function* (input: {
      readonly repository: BitbucketServerRepositoryLocator;
      readonly branch: string;
      readonly state: string;
      readonly limit: number;
      readonly owner: string | undefined;
    }) {
      const collected: Array<NormalizedBitbucketPullRequestRecord> = [];
      let start = 0;
      for (let page = 0; page < MAX_LIST_PAGES && collected.length < input.limit; page += 1) {
        const result = yield* executeJson(
          "listPullRequests",
          (connection) =>
            HttpClientRequest.get(
              apiUrl(connection, `${repositoryPath(input.repository)}/pull-requests`),
              {
                urlParams: {
                  direction: "OUTGOING",
                  at: `refs/heads/${input.branch}`,
                  state: input.state,
                  order: "NEWEST",
                  limit: String(Math.min(input.limit - collected.length, MAX_PAGE_SIZE)),
                  start: String(start),
                },
              },
            ),
          BitbucketServerPullRequestPageSchema,
        );
        for (const raw of result.values) {
          if (
            input.owner !== undefined &&
            raw.fromRef.repository?.project.key.toLowerCase() !== input.owner.toLowerCase()
          ) {
            continue;
          }
          collected.push(normalizeBitbucketServerPullRequestRecord(raw));
        }
        if (result.isLastPage || result.nextPageStart === undefined) break;
        start = result.nextPageStart;
      }
      return collected.slice(0, input.limit);
    },
  );

  const trustedUrl = (connection: BitbucketServerConnection, value: string): string | null => {
    if (!/^https?:\/\//u.test(value)) return `${connection.baseUrl}${value}`;
    return originOf(value) === connection.origin ? value : null;
  };

  const request: BitbucketServerApi["Service"]["request"] = (input) =>
    withConnection((connection) => {
      const url = trustedUrl(connection, input.url);
      if (url === null) {
        return Effect.fail(
          new BitbucketServerUntrustedUrlError({
            host: originOf(input.url) ?? "an unreadable url",
          }),
        );
      }
      const base = HttpClientRequest.make(input.method)(url).pipe(
        input.accept === undefined ? (request) => request : HttpClientRequest.accept(input.accept),
      );
      const withBody =
        input.body === undefined
          ? base
          : base.pipe(HttpClientRequest.bodyText(input.body, "application/json"));
      return send("request", connection, withBody).pipe(
        Effect.flatMap((response) =>
          HttpClientResponse.matchStatus({
            "2xx": (success) =>
              collectUint8StreamText({
                stream: success.stream,
                maxBytes: input.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new BitbucketServerResponseBodyReadError({
                      operation: "request",
                      status: success.status,
                      cause,
                    }),
                ),
                Effect.map((collected) => ({
                  body: collected.text,
                  truncated: collected.truncated,
                })),
              ),
            orElse: (failed) => responseError("request", failed),
          })(response),
        ),
      );
    });

  const probeAuth: BitbucketServerApi["Service"]["probeAuth"] = Option.match(connection, {
    onNone: () =>
      Effect.succeed<SourceControlProviderAuth>({
        status: "unauthenticated",
        account: Option.none(),
        host: Option.none(),
        detail: Option.some(CONFIGURATION_HINT),
      }),
    onSome: (connection) =>
      send(
        "probeAuth",
        connection,
        HttpClientRequest.get(apiUrl(connection, "/projects"), {
          urlParams: { limit: "1" },
        }).pipe(HttpClientRequest.acceptJson),
      ).pipe(
        Effect.map((response): SourceControlProviderAuth => {
          if (response.status >= 200 && response.status < 300) {
            const rawAccount = response.headers["x-ausername"];
            let account = rawAccount;
            try {
              account = rawAccount === undefined ? undefined : decodeURIComponent(rawAccount);
            } catch {}
            return {
              status: "authenticated",
              account: nonEmpty(account),
              host: Option.some(connection.hostname),
              detail: Option.none(),
            };
          }
          if (response.status === 401 || response.status === 403) {
            return {
              status: "unauthenticated",
              account: Option.none(),
              host: Option.some(connection.hostname),
              detail: Option.some(
                `${connection.hostname} rejected T3CODE_BITBUCKET_SERVER_TOKEN (HTTP ${response.status}).`,
              ),
            };
          }
          return {
            status: "unknown",
            account: Option.none(),
            host: Option.some(connection.hostname),
            detail: Option.some(`${connection.hostname} returned HTTP ${response.status}.`),
          };
        }),
        Effect.orElseSucceed((): SourceControlProviderAuth => ({
          status: "unknown",
          account: Option.none(),
          host: Option.some(connection.hostname),
          detail: Option.some(`${connection.hostname} could not be reached.`),
        })),
      ),
  });

  return BitbucketServerApi.of({
    probeAuth,
    request,
    listPullRequests: (input) =>
      resolveRepository(input).pipe(
        Effect.flatMap((repository) =>
          listPullRequestPages({
            repository,
            branch: SourceControlProvider.sourceBranch(input),
            state: toBitbucketServerState(input.state),
            limit: Math.max(1, input.limit ?? 20),
            owner: sourceOwner(input),
          }),
        ),
      ),
    getPullRequest: (input) =>
      resolveRepository(input).pipe(
        Effect.flatMap((repository) => getRawPullRequest(repository, input.reference)),
        Effect.map(normalizeBitbucketServerPullRequestRecord),
      ),
    getRepositoryCloneUrls: (input) =>
      resolveRepository(input).pipe(
        Effect.flatMap(getRepositoryFromLocator),
        Effect.map(normalizeRepositoryCloneUrls),
      ),
    createPullRequest: (input) =>
      Effect.gen(function* () {
        const repository = yield* resolveRepository(input);
        const description = yield* fileSystem.readFileString(input.bodyFile).pipe(
          Effect.mapError(
            (cause) =>
              new BitbucketServerPullRequestBodyReadError({
                cwd: input.cwd,
                bodyFile: input.bodyFile,
                cause,
              }),
          ),
        );
        const owner = sourceOwner(input);
        const body = {
          title: input.title,
          description,
          fromRef: {
            id: `refs/heads/${SourceControlProvider.sourceBranch(input)}`,
            repository: {
              slug: input.source?.repository ?? repository.repoSlug,
              project: { key: owner ?? repository.projectKey },
            },
          },
          toRef: {
            id: `refs/heads/${input.target?.refName ?? input.baseBranch}`,
            repository: {
              slug: repository.repoSlug,
              project: { key: repository.projectKey },
            },
          },
        };
        const created = yield* executeJson(
          "createPullRequest",
          (connection) =>
            HttpClientRequest.post(
              apiUrl(connection, `${repositoryPath(repository)}/pull-requests`),
            ).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
          BitbucketServerPullRequestSchema,
        );
        return normalizeBitbucketServerPullRequestRecord(created);
      }),
    getDefaultBranch: (input) =>
      resolveRepository(input).pipe(
        Effect.flatMap((repository) =>
          executeJson(
            "getDefaultBranch",
            (connection) =>
              HttpClientRequest.get(
                apiUrl(connection, `${repositoryPath(repository)}/default-branch`),
              ),
            RawBitbucketServerDefaultBranchSchema,
          ),
        ),
        Effect.map((branch) => branch.displayId),
      ),
    checkoutPullRequest: (input) =>
      Effect.gen(function* () {
        const repository = yield* resolveRepository(input);
        const pullRequest = normalizeBitbucketServerPullRequestRecord(
          yield* getRawPullRequest(repository, input.reference),
        );
        const isCrossRepository = pullRequest.isCrossRepository === true;
        const remoteName =
          input.context?.provider.kind === "bitbucket-server"
            ? input.context.remoteName
            : yield* git.resolvePrimaryRemoteName(input.cwd);
        const localBranch = checkoutBranchName({
          pullRequestId: pullRequest.number,
          headBranch: pullRequest.headRefName,
          isCrossRepository,
        });
        const localBranchExists = (yield* git.listLocalBranchNames(input.cwd)).includes(
          localBranch,
        );

        if (input.force === true || !localBranchExists) {
          yield* git.fetchRemoteRef({
            cwd: input.cwd,
            remoteName,
            remoteRef: `refs/pull-requests/${pullRequest.number}/from`,
            localBranch,
          });
        }
        if (!isCrossRepository) {
          yield* git.fetchRemoteTrackingBranch({
            cwd: input.cwd,
            remoteName,
            remoteBranch: pullRequest.headRefName,
          });
          yield* git.setBranchUpstream({
            cwd: input.cwd,
            branch: localBranch,
            remoteName,
            remoteBranch: pullRequest.headRefName,
          });
        }
        yield* Effect.scoped(git.switchRef({ cwd: input.cwd, refName: localBranch }));
      }).pipe(
        Effect.mapError((cause) =>
          isBitbucketServerApiError(cause)
            ? cause
            : new BitbucketServerCheckoutError({
                cwd: input.cwd,
                reference: input.reference,
                cause,
              }),
        ),
      ),
  });
});

export const layer = Layer.effect(BitbucketServerApi, make);
