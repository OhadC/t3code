import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as BitbucketServerApi from "./BitbucketServerApi.ts";
import * as BitbucketServerSourceControlProvider from "./BitbucketServerSourceControlProvider.ts";

function makeProvider(bitbucket: Partial<BitbucketServerApi.BitbucketServerApi["Service"]>) {
  return BitbucketServerSourceControlProvider.make.pipe(
    Effect.provide(Layer.mock(BitbucketServerApi.BitbucketServerApi)(bitbucket)),
  );
}

it.effect("maps Data Center pull requests into bitbucket-server change requests", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      getPullRequest: () =>
        Effect.succeed({
          number: 1,
          title: "Fixture PR",
          url: "https://bitbucket.example.com/projects/PROJ/repos/web/pull-requests/1",
          baseRefName: "main",
          headRefName: "feature/dc-fixture",
          state: "open",
          isDraft: true,
          updatedAt: Option.none(),
          headRepositoryNameWithOwner: "PROJ/web",
          headRepositoryOwnerLogin: "PROJ",
        }),
    });

    const changeRequest = yield* provider.getChangeRequest({ cwd: "/repo", reference: "1" });

    assert.deepStrictEqual(changeRequest, {
      provider: "bitbucket-server",
      number: 1,
      title: "Fixture PR",
      url: "https://bitbucket.example.com/projects/PROJ/repos/web/pull-requests/1",
      baseRefName: "main",
      headRefName: "feature/dc-fixture",
      state: "open",
      isDraft: true,
      updatedAt: Option.none(),
      headRepositoryNameWithOwner: "PROJ/web",
      headRepositoryOwnerLogin: "PROJ",
    });
  }),
);

it.effect("refuses to create repositories with a clear unsupported error", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({});

    const error = yield* provider
      .createRepository({ cwd: "/repo", repository: "PROJ/web", visibility: "private" })
      .pipe(Effect.flip);

    assert.strictEqual(error.provider, "bitbucket-server");
    assert.strictEqual(error.operation, "createRepository");
    assert.strictEqual(error.repository, "PROJ/web");
    assert.include(error.detail, "does not support publishing");
  }),
);

it.effect("wraps API failures with the operation while keeping the cause", () =>
  Effect.gen(function* () {
    const cause = new BitbucketServerApi.BitbucketServerHostMismatchError({
      remoteHost: "bitbucket.other.example",
      configuredHost: "bitbucket.example.com",
    });
    const provider = yield* makeProvider({
      getDefaultBranch: () => Effect.fail(cause),
    });

    const error = yield* provider.getDefaultBranch({ cwd: "/repo" }).pipe(Effect.flip);

    assert.strictEqual(error.provider, "bitbucket-server");
    assert.strictEqual(error.operation, "getDefaultBranch");
    assert.strictEqual(error.cause, cause);
  }),
);
