import { assert, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { GitCommandError } from "@t3tools/contracts";
import * as ServerSettings from "../serverSettings.ts";
import * as BitbucketServerApi from "./BitbucketServerApi.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import type * as VcsDriver from "../vcs/VcsDriver.ts";

const API = "https://bitbucket.example.com/bitbucket/rest/api/1.0";
const REPO = `${API}/projects/~ohcohen/repos/testing-repo`;

const repositoryRef = {
  slug: "testing-repo",
  id: 11754,
  name: "testing-repo",
  scmId: "git",
  state: "AVAILABLE",
  project: { key: "~OHCOHEN", id: 277, name: "Cohen, Ohad", type: "PERSONAL" },
  links: {
    clone: [
      {
        href: "https://bitbucket.example.com/bitbucket/scm/~ohcohen/testing-repo.git",
        name: "http",
      },
      { href: "ssh://git@bitbucket.example.com:7999/~ohcohen/testing-repo.git", name: "ssh" },
    ],
    self: [
      { href: "https://bitbucket.example.com/bitbucket/users/ohcohen/repos/testing-repo/browse" },
    ],
  },
};

const pullRequestJson = {
  id: 1,
  version: 0,
  title: "Fixture PR",
  description: "Body from curl",
  state: "OPEN",
  open: true,
  closed: false,
  draft: false,
  createdDate: 1789241900634,
  updatedDate: 1789241900634,
  fromRef: {
    id: "refs/heads/feature/dc-fixture",
    displayId: "feature/dc-fixture",
    latestCommit: "96a2b51825a99ca808762c960d2d4c4f82dfde15",
    type: "BRANCH",
    repository: repositoryRef,
  },
  toRef: {
    id: "refs/heads/main",
    displayId: "main",
    latestCommit: "a35a529320a97c51808f6647eb1f59518371b3e9",
    type: "BRANCH",
    repository: repositoryRef,
  },
  locked: false,
  reviewers: [],
  participants: [],
  links: {
    self: [
      {
        href: "https://bitbucket.example.com/bitbucket/users/ohcohen/repos/testing-repo/pull-requests/1",
      },
    ],
  },
};

const page = (values: ReadonlyArray<unknown>, extra: Record<string, unknown> = {}) =>
  Response.json({ size: values.length, limit: 25, isLastPage: true, values, start: 0, ...extra });

function makeLayer(input: {
  readonly response: (request: HttpClientRequest.HttpClientRequest) => Response;
  readonly env?: Record<string, string>;
  readonly remoteUrl?: string;
  readonly git?: Partial<GitVcsDriver.GitVcsDriver["Service"]>;
}) {
  const execute = vi.fn((request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, input.response(request))),
  );
  const gitMock = {
    resolvePrimaryRemoteName: vi.fn<
      GitVcsDriver.GitVcsDriver["Service"]["resolvePrimaryRemoteName"]
    >(() => Effect.succeed("origin")),
    fetchRemoteRef: vi.fn<GitVcsDriver.GitVcsDriver["Service"]["fetchRemoteRef"]>(
      () => Effect.void,
    ),
    fetchRemoteTrackingBranch: vi.fn<
      GitVcsDriver.GitVcsDriver["Service"]["fetchRemoteTrackingBranch"]
    >(() => Effect.void),
    setBranchUpstream: vi.fn<GitVcsDriver.GitVcsDriver["Service"]["setBranchUpstream"]>(
      () => Effect.void,
    ),
    switchRef: vi.fn<GitVcsDriver.GitVcsDriver["Service"]["switchRef"]>((request) =>
      Effect.succeed({ refName: request.refName }),
    ),
    listLocalBranchNames: vi.fn<GitVcsDriver.GitVcsDriver["Service"]["listLocalBranchNames"]>(() =>
      Effect.succeed([]),
    ),
  };
  const driver = {
    listRemotes: () =>
      Effect.succeed({
        remotes: [
          {
            name: "origin",
            url:
              input.remoteUrl ??
              "https://bitbucket.example.com:8443/bitbucket/scm/~ohcohen/testing-repo.git",
            pushUrl: Option.none(),
            isPrimary: true,
          },
        ],
        freshness: {
          source: "live-local" as const,
          observedAt: DateTime.makeUnsafe("1970-01-01T00:00:00.000Z"),
          expiresAt: Option.none(),
        },
      }),
  } satisfies Partial<VcsDriver.VcsDriver["Service"]>;

  const layer = BitbucketServerApi.layer.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => execute(request)),
      ),
    ),
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        resolve: () =>
          Effect.succeed({
            kind: "git",
            repository: {
              kind: "git",
              rootPath: "/repo",
              metadataPath: null,
              freshness: {
                source: "live-local" as const,
                observedAt: DateTime.makeUnsafe("1970-01-01T00:00:00.000Z"),
                expiresAt: Option.none(),
              },
            },
            driver: driver as unknown as VcsDriver.VcsDriver["Service"],
          }),
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({ ...gitMock, ...input.git })),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: input.env ?? {
            T3CODE_BITBUCKET_SERVER_URL: "https://bitbucket.example.com/bitbucket/",
            T3CODE_BITBUCKET_SERVER_TOKEN: "dc-token",
          },
        }),
      ),
    ),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(NodeServices.layer),
  );

  return { execute, git: gitMock, layer };
}

const requestBody = (request: HttpClientRequest.HttpClientRequest | undefined) => {
  const rawBody = (request?.body as { readonly body?: Uint8Array } | undefined)?.body;
  assert.ok(rawBody);
  return JSON.parse(new TextDecoder().decode(rawBody)) as unknown;
};

it.effect("reports the account from X-AUSERNAME when both variables are set", () => {
  const { execute, layer } = makeLayer({
    response: () =>
      Response.json(
        { size: 0, limit: 1, isLastPage: true, values: [], start: 0 },
        { headers: { "X-AUSERNAME": "access-token-user%2F2%2F11754" } },
      ),
  });

  return Effect.gen(function* () {
    const auth = yield* (yield* BitbucketServerApi.BitbucketServerApi).probeAuth;

    assert.deepStrictEqual(auth, {
      status: "authenticated",
      account: Option.some("access-token-user/2/11754"),
      host: Option.some("bitbucket.example.com"),
      detail: Option.none(),
    });
    const request = execute.mock.calls[0]?.[0];
    assert.strictEqual(request?.url, `${API}/projects`);
    assert.deepStrictEqual(request?.urlParams.params, [["limit", "1"]]);
    assert.strictEqual(request?.headers.authorization, "Bearer dc-token");
  }).pipe(Effect.provide(layer));
});

it.effect("reports a rejected token as unauthenticated", () => {
  const { layer } = makeLayer({ response: () => new Response("", { status: 401 }) });

  return Effect.gen(function* () {
    const auth = yield* (yield* BitbucketServerApi.BitbucketServerApi).probeAuth;

    assert.deepStrictEqual(auth, {
      status: "unauthenticated",
      account: Option.none(),
      host: Option.some("bitbucket.example.com"),
      detail: Option.some("bitbucket.example.com rejected the configured token (HTTP 401)."),
    });
  }).pipe(Effect.provide(layer));
});

it.effect(
  "prefers a host and token saved in settings over the environment, without a restart",
  () => {
    const { execute, layer } = makeLayer({
      response: () => Response.json({ size: 0, limit: 1, isLastPage: true, values: [], start: 0 }),
    });
    const lastRequest = () => execute.mock.calls.at(-1)?.[0];

    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketServerApi.BitbucketServerApi;
      const settings = yield* ServerSettings.ServerSettingsService;

      yield* bitbucket.probeAuth;
      assert.strictEqual(lastRequest()?.url, `${API}/projects`);
      assert.strictEqual(lastRequest()?.headers.authorization, "Bearer dc-token");

      yield* settings.updateSettings({
        bitbucketServer: { url: "https://dc.example.com/context/", token: "saved-token" },
      });
      yield* bitbucket.probeAuth;
      assert.strictEqual(
        lastRequest()?.url,
        "https://dc.example.com/context/rest/api/1.0/projects",
      );
      assert.strictEqual(lastRequest()?.headers.authorization, "Bearer saved-token");

      yield* settings.updateSettings({ bitbucketServer: { token: "" } });
      yield* bitbucket.probeAuth;
      assert.strictEqual(lastRequest()?.url, `${API}/projects`);
      assert.strictEqual(lastRequest()?.headers.authorization, "Bearer dc-token");
    }).pipe(Effect.provide(layer));
  },
);

it.effect("never puts a saved token that is unsafe for an HTTP header on the wire", () => {
  const { execute, layer } = makeLayer({
    response: () => Response.json({ size: 0, limit: 1, isLastPage: true, values: [], start: 0 }),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketServerApi.BitbucketServerApi;
    const settings = yield* ServerSettings.ServerSettingsService;

    yield* settings.updateSettings({
      bitbucketServer: { url: "https://dc.example.com", token: "saved\ntoken" },
    });
    yield* bitbucket.probeAuth;
    assert.strictEqual(execute.mock.calls.at(-1)?.[0].headers.authorization, "Bearer dc-token");
  }).pipe(Effect.provide(layer));
});

it.effect("names both variables when either is missing, without sending a request", () => {
  const { execute, layer } = makeLayer({
    response: () => Response.json({}),
    env: { T3CODE_BITBUCKET_SERVER_URL: "https://bitbucket.example.com" },
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketServerApi.BitbucketServerApi;
    const auth = yield* bitbucket.probeAuth;

    assert.strictEqual(auth.status, "unauthenticated");
    assert.match(
      Option.getOrElse(auth.detail, () => ""),
      /T3CODE_BITBUCKET_SERVER_URL and T3CODE_BITBUCKET_SERVER_TOKEN/u,
    );

    const error = yield* Effect.flip(bitbucket.getDefaultBranch({ cwd: "/repo" }));
    assert.strictEqual(error._tag, "BitbucketServerNotConfiguredError");
    assert.strictEqual(execute.mock.calls.length, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("reads clone URLs and the default branch for a repository found through the cwd", () => {
  const { execute, layer } = makeLayer({
    response: (request) =>
      request.url.endsWith("/default-branch")
        ? Response.json({ id: "refs/heads/main", displayId: "main", type: "BRANCH" })
        : Response.json(repositoryRef),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketServerApi.BitbucketServerApi;
    const cloneUrls = yield* bitbucket.getRepositoryCloneUrls({
      cwd: "/repo",
      repository: "~ohcohen/testing-repo",
    });
    const defaultBranch = yield* bitbucket.getDefaultBranch({ cwd: "/repo" });

    assert.deepStrictEqual(cloneUrls, {
      nameWithOwner: "~OHCOHEN/testing-repo",
      url: "https://bitbucket.example.com/bitbucket/scm/~ohcohen/testing-repo.git",
      sshUrl: "ssh://git@bitbucket.example.com:7999/~ohcohen/testing-repo.git",
    });
    assert.strictEqual(defaultBranch, "main");
    assert.deepStrictEqual(
      execute.mock.calls.map((call) => call[0].url),
      [REPO, `${REPO}/default-branch`],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("resolves the repository from an ssh remote in the provider context", () => {
  const { execute, layer } = makeLayer({
    response: () => Response.json({ id: "refs/heads/develop", displayId: "develop" }),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketServerApi.BitbucketServerApi;
    const defaultBranch = yield* bitbucket.getDefaultBranch({
      cwd: "/repo",
      context: {
        provider: {
          kind: "bitbucket-server",
          name: "Bitbucket Data Center",
          baseUrl: "https://bitbucket.example.com",
        },
        remoteName: "origin",
        remoteUrl: "ssh://git@bitbucket.example.com:7999/PROJ/web.git",
      },
    });

    assert.strictEqual(defaultBranch, "develop");
    assert.strictEqual(
      execute.mock.calls[0]?.[0].url,
      `${API}/projects/PROJ/repos/web/default-branch`,
    );
  }).pipe(Effect.provide(layer));
});

it.effect("fails loudly when the remote is a Bitbucket host other than the configured one", () => {
  const { execute, layer } = makeLayer({
    response: () => Response.json(repositoryRef),
    remoteUrl: "https://bitbucket.other.example/scm/PROJ/web.git",
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketServerApi.BitbucketServerApi;
    const error = yield* Effect.flip(bitbucket.getDefaultBranch({ cwd: "/repo" }));

    assert.instanceOf(error, BitbucketServerApi.BitbucketServerHostMismatchError);
    assert.include(error.message, "bitbucket.other.example");
    assert.include(error.message, "bitbucket.example.com");
    assert.strictEqual(execute.mock.calls.length, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("lists a branch's pull requests with Data Center state and ref filters", () => {
  const { execute, layer } = makeLayer({
    response: () =>
      page([
        pullRequestJson,
        { ...pullRequestJson, id: 2, state: "MERGED", draft: true, updatedDate: null },
        { ...pullRequestJson, id: 3, state: "DECLINED" },
      ]),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketServerApi.BitbucketServerApi;
    const result = yield* bitbucket.listPullRequests({
      cwd: "/repo",
      headSelector: "feature/dc-fixture",
      state: "all",
      limit: 10,
    });

    assert.deepStrictEqual(result[0], {
      number: 1,
      title: "Fixture PR",
      url: "https://bitbucket.example.com/bitbucket/users/ohcohen/repos/testing-repo/pull-requests/1",
      baseRefName: "main",
      headRefName: "feature/dc-fixture",
      state: "open",
      updatedAt: Option.some(DateTime.makeUnsafe(1789241900634)),
      headRepositoryNameWithOwner: "~OHCOHEN/testing-repo",
      headRepositoryOwnerLogin: "~OHCOHEN",
    });
    assert.deepStrictEqual(
      result.map((item) => [item.state, item.isDraft ?? false]),
      [
        ["open", false],
        ["merged", true],
        ["closed", false],
      ],
    );
    assert.strictEqual(result[1]?.updatedAt._tag, "None");
    const request = execute.mock.calls[0]?.[0];
    assert.strictEqual(request?.url, `${REPO}/pull-requests`);
    assert.deepStrictEqual(request?.urlParams.params, [
      ["direction", "OUTGOING"],
      ["at", "refs/heads/feature/dc-fixture"],
      ["state", "ALL"],
      ["order", "NEWEST"],
      ["limit", "10"],
      ["start", "0"],
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("maps closed to DECLINED and follows nextPageStart until the limit is met", () => {
  const { execute, layer } = makeLayer({
    response: (request) =>
      request.urlParams.params.some(([key, value]) => key === "start" && value === "0")
        ? page([{ ...pullRequestJson, id: 3, state: "DECLINED" }], {
            isLastPage: false,
            nextPageStart: 1,
          })
        : page([{ ...pullRequestJson, id: 2, state: "DECLINED" }]),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketServerApi.BitbucketServerApi;
    const result = yield* bitbucket.listPullRequests({
      cwd: "/repo",
      headSelector: "feature/dc-fixture",
      state: "closed",
      limit: 2,
    });

    assert.deepStrictEqual(
      result.map((item) => item.number),
      [3, 2],
    );
    assert.deepStrictEqual(
      execute.mock.calls.map((call) =>
        call[0].urlParams.params.filter(
          ([key]) => key === "state" || key === "start" || key === "limit",
        ),
      ),
      [
        [
          ["state", "DECLINED"],
          ["limit", "2"],
          ["start", "0"],
        ],
        [
          ["state", "DECLINED"],
          ["limit", "1"],
          ["start", "1"],
        ],
      ],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("keeps only pull requests from the owner named by an owner:branch selector", () => {
  const fork = { ...repositoryRef, slug: "testing-repo", project: { key: "FORKS" } };
  const { layer } = makeLayer({
    response: () =>
      page([
        pullRequestJson,
        { ...pullRequestJson, id: 9, fromRef: { ...pullRequestJson.fromRef, repository: fork } },
      ]),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketServerApi.BitbucketServerApi;
    const result = yield* bitbucket.listPullRequests({
      cwd: "/repo",
      headSelector: "forks:feature/dc-fixture",
      state: "open",
    });

    assert.deepStrictEqual(
      result.map((item) => item.number),
      [9],
    );
    assert.strictEqual(result[0]?.isCrossRepository, true);
    assert.strictEqual(result[0]?.headRepositoryNameWithOwner, "FORKS/testing-repo");
  }).pipe(Effect.provide(layer));
});

it.effect("gets a pull request by number and by URL", () => {
  const { execute, layer } = makeLayer({ response: () => Response.json(pullRequestJson) });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketServerApi.BitbucketServerApi;
    const byNumber = yield* bitbucket.getPullRequest({ cwd: "/repo", reference: "#1" });
    const byUrl = yield* bitbucket.getPullRequest({
      cwd: "/repo",
      reference:
        "https://bitbucket.example.com/bitbucket/projects/~OHCOHEN/repos/testing-repo/pull-requests/1/overview",
    });

    assert.strictEqual(byNumber.number, 1);
    assert.deepStrictEqual(byUrl, byNumber);
    assert.deepStrictEqual(
      execute.mock.calls.map((call) => call[0].url),
      [`${REPO}/pull-requests/1`, `${REPO}/pull-requests/1`],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("creates a pull request from fromRef/toRef with the body file's content", () => {
  const { execute, layer } = makeLayer({ response: () => Response.json(pullRequestJson) });

  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const bodyFile = yield* fileSystem.makeTempFileScoped({ prefix: "bitbucket-server-pr-body-" });
    yield* fileSystem.writeFileString(bodyFile, "PR body");

    const bitbucket = yield* BitbucketServerApi.BitbucketServerApi;
    const created = yield* bitbucket.createPullRequest({
      cwd: "/repo",
      baseBranch: "main",
      headSelector: "feature/dc-fixture",
      title: "Fixture PR",
      bodyFile,
    });

    assert.strictEqual(
      created.url,
      "https://bitbucket.example.com/bitbucket/users/ohcohen/repos/testing-repo/pull-requests/1",
    );
    const request = execute.mock.calls[0]?.[0];
    assert.strictEqual(request?.url, `${REPO}/pull-requests`);
    assert.strictEqual(request?.method, "POST");
    assert.deepStrictEqual(requestBody(request), {
      title: "Fixture PR",
      description: "PR body",
      fromRef: {
        id: "refs/heads/feature/dc-fixture",
        repository: { slug: "testing-repo", project: { key: "~ohcohen" } },
      },
      toRef: {
        id: "refs/heads/main",
        repository: { slug: "testing-repo", project: { key: "~ohcohen" } },
      },
    });
  }).pipe(Effect.provide(layer), Effect.scoped);
});

it.effect("creates a fork pull request against the owner from the head selector", () => {
  const { execute, layer } = makeLayer({ response: () => Response.json(pullRequestJson) });

  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const bodyFile = yield* fileSystem.makeTempFileScoped({ prefix: "bitbucket-server-pr-body-" });
    yield* fileSystem.writeFileString(bodyFile, "");

    const bitbucket = yield* BitbucketServerApi.BitbucketServerApi;
    yield* bitbucket.createPullRequest({
      cwd: "/repo",
      baseBranch: "main",
      headSelector: "FORKS:feature/dc-fixture",
      title: "Fork PR",
      bodyFile,
    });

    const body = requestBody(execute.mock.calls[0]?.[0]) as { fromRef: unknown };
    assert.deepStrictEqual(body.fromRef, {
      id: "refs/heads/feature/dc-fixture",
      repository: { slug: "testing-repo", project: { key: "FORKS" } },
    });
  }).pipe(Effect.provide(layer), Effect.scoped);
});

it.effect(
  "checks out a pull request from refs/pull-requests/{id}/from and tracks its branch",
  () => {
    const { git, layer } = makeLayer({ response: () => Response.json(pullRequestJson) });

    return Effect.gen(function* () {
      const bitbucket = yield* BitbucketServerApi.BitbucketServerApi;
      yield* bitbucket.checkoutPullRequest({
        cwd: "/repo",
        context: {
          provider: {
            kind: "bitbucket-server",
            name: "Bitbucket Data Center",
            baseUrl: "https://bitbucket.example.com",
          },
          remoteName: "upstream",
          remoteUrl: "https://bitbucket.example.com/bitbucket/scm/~ohcohen/testing-repo.git",
        },
        reference: "1",
      });

      assert.deepStrictEqual(git.fetchRemoteRef.mock.calls[0]?.[0], {
        cwd: "/repo",
        remoteName: "upstream",
        remoteRef: "refs/pull-requests/1/from",
        localBranch: "feature/dc-fixture",
      });
      assert.deepStrictEqual(git.setBranchUpstream.mock.calls[0]?.[0], {
        cwd: "/repo",
        branch: "feature/dc-fixture",
        remoteName: "upstream",
        remoteBranch: "feature/dc-fixture",
      });
      assert.deepStrictEqual(git.switchRef.mock.calls[0]?.[0], {
        cwd: "/repo",
        refName: "feature/dc-fixture",
      });
    }).pipe(Effect.provide(layer));
  },
);

it.effect("leaves an existing local branch alone unless force is set", () => {
  const existing = { listLocalBranchNames: () => Effect.succeed(["feature/dc-fixture"]) };
  const gentle = makeLayer({ response: () => Response.json(pullRequestJson), git: existing });
  const forced = makeLayer({ response: () => Response.json(pullRequestJson), git: existing });

  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const bitbucket = yield* BitbucketServerApi.BitbucketServerApi;
      yield* bitbucket.checkoutPullRequest({ cwd: "/repo", reference: "1" });
    }).pipe(Effect.provide(gentle.layer));
    yield* Effect.gen(function* () {
      const bitbucket = yield* BitbucketServerApi.BitbucketServerApi;
      yield* bitbucket.checkoutPullRequest({ cwd: "/repo", reference: "1", force: true });
    }).pipe(Effect.provide(forced.layer));

    assert.strictEqual(gentle.git.fetchRemoteRef.mock.calls.length, 0);
    assert.strictEqual(gentle.git.switchRef.mock.calls.length, 1);
    assert.strictEqual(forced.git.fetchRemoteRef.mock.calls.length, 1);
    assert.strictEqual(forced.git.fetchRemoteRef.mock.calls[0]?.[0].remoteName, "origin");
  });
});

it.effect("checks out a fork pull request on a PR-named branch without an upstream", () => {
  const { git, layer } = makeLayer({
    response: () =>
      Response.json({
        ...pullRequestJson,
        fromRef: {
          ...pullRequestJson.fromRef,
          repository: { ...repositoryRef, project: { key: "FORKS" } },
        },
      }),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketServerApi.BitbucketServerApi;
    yield* bitbucket.checkoutPullRequest({ cwd: "/repo", reference: "1" });

    assert.deepStrictEqual(git.fetchRemoteRef.mock.calls[0]?.[0], {
      cwd: "/repo",
      remoteName: "origin",
      remoteRef: "refs/pull-requests/1/from",
      localBranch: "t3code/pr-1/feature/dc-fixture",
    });
    assert.strictEqual(git.setBranchUpstream.mock.calls.length, 0);
    assert.strictEqual(git.switchRef.mock.calls[0]?.[0].refName, "t3code/pr-1/feature/dc-fixture");
  }).pipe(Effect.provide(layer));
});

it.effect("wraps Git checkout failures without deriving the message from them", () => {
  const gitCause = new GitCommandError({
    operation: "fetchRemoteRef",
    command: "git fetch origin refs/pull-requests/1/from",
    cwd: "/repo",
    detail: "remote rejected the request",
  });
  const { layer } = makeLayer({
    response: () => Response.json(pullRequestJson),
    git: { fetchRemoteRef: () => Effect.fail(gitCause) },
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketServerApi.BitbucketServerApi;
    const error = yield* Effect.flip(
      bitbucket.checkoutPullRequest({ cwd: "/repo", reference: "1" }),
    );

    assert.instanceOf(error, BitbucketServerApi.BitbucketServerCheckoutError);
    assert.strictEqual(error.cause, gitCause);
    assert.notInclude(error.message, "remote rejected");
  }).pipe(Effect.provide(layer));
});

it.effect("keeps raw response bodies out of errors and a 429 Retry-After on them", () => {
  const { layer } = makeLayer({
    response: (request) =>
      request.url.endsWith("/pull-requests/1")
        ? new Response("<html>credential=secret-value</html>", { status: 403 })
        : new Response("busy", { status: 429, headers: { "Retry-After": "120" } }),
  });

  return Effect.gen(function* () {
    yield* TestClock.setTime(1_000);
    const bitbucket = yield* BitbucketServerApi.BitbucketServerApi;

    const forbidden = yield* Effect.flip(
      bitbucket.getPullRequest({ cwd: "/repo", reference: "1" }),
    );
    assert.instanceOf(forbidden, BitbucketServerApi.BitbucketServerResponseError);
    assert.strictEqual(forbidden.status, 403);
    assert.notInclude(forbidden.message, "secret-value");

    const limited = yield* Effect.flip(
      bitbucket.request({ method: "GET", url: "/rest/build-status/1.0/commits/abc" }),
    );
    assert.instanceOf(limited, BitbucketServerApi.BitbucketServerResponseError);
    assert.strictEqual(limited.status, 429);
    assert.strictEqual(limited.retryAt, 121_000);
  }).pipe(Effect.provide(layer));
});

it.effect("carries the host's own message from a structured errors document", () => {
  const { layer } = makeLayer({
    response: () =>
      Response.json(
        {
          errors: [
            { message: "Squash is not enabled for this repository.", exceptionName: "x" },
            { message: "  " },
            { message: "Pick another strategy." },
          ],
        },
        { status: 409 },
      ),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketServerApi.BitbucketServerApi;
    const error = yield* Effect.flip(
      bitbucket.request({
        method: "POST",
        url: "/rest/api/1.0/projects/P/repos/r/pull-requests/1/merge",
      }),
    );
    assert.instanceOf(error, BitbucketServerApi.BitbucketServerResponseError);
    assert.strictEqual(error.status, 409);
    assert.strictEqual(
      error.hostMessage,
      "Squash is not enabled for this repository. Pick another strategy.",
    );
    assert.include(error.message, "HTTP 409: Squash is not enabled for this repository.");
  }).pipe(Effect.provide(layer));
});

it.effect("sends raw requests below the base URL and refuses urls on other hosts", () => {
  const { execute, layer } = makeLayer({
    response: () => new Response("diff --git a/a.ts b/a.ts", { status: 200 }),
  });

  return Effect.gen(function* () {
    const bitbucket = yield* BitbucketServerApi.BitbucketServerApi;
    const result = yield* bitbucket.request({
      method: "GET",
      url: "/rest/api/1.0/projects/P/repos/r/pull-requests/1.diff",
      maxBytes: 8,
    });
    assert.deepStrictEqual(result, { body: "diff --g", truncated: true });
    assert.strictEqual(
      execute.mock.calls[0]?.[0].url,
      "https://bitbucket.example.com/bitbucket/rest/api/1.0/projects/P/repos/r/pull-requests/1.diff",
    );

    const error = yield* Effect.flip(
      bitbucket.request({ method: "GET", url: "https://attacker.example/x?signature=secret" }),
    );
    assert.strictEqual(error._tag, "BitbucketServerUntrustedUrlError");
    assert.notInclude(error.message, "secret");
    assert.strictEqual(execute.mock.calls.length, 1);
  }).pipe(Effect.provide(layer));
});
