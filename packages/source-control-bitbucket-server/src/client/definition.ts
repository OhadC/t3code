/**
 * Bitbucket Data Center's client definition. Browser- and React Native-safe.
 *
 * @module source-control-bitbucket-server/client/definition
 */
import {
  makeProviderSettingsSchema,
  SourceControlProviderKind,
  TrimmedString,
} from "@t3tools/contracts";
import {
  BITBUCKET_SERVER_PULL_REQUEST_PATH,
  changeRequestUrlFor,
} from "@t3tools/shared/changeRequestUrl";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  defineSourceControlClient,
  isChangeRequestInProjectRepository,
  isChangeRequestOnProjectHost,
} from "@t3tools/source-control-core/client/definition";

const KIND = SourceControlProviderKind.make("bitbucket-server");

const text = (annotations: Schema.Annotations.Key<string>) =>
  TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
    Schema.annotateKey(annotations),
  );

/**
 * The Data Center host and an HTTP access token, used before the `T3CODE_BITBUCKET_SERVER_*`
 * environment variables.
 */
export const settings = makeProviderSettingsSchema(
  {
    url: text({
      title: "Host URL",
      description: "Include the context path if Bitbucket is served under one.",
      providerSettingsForm: { placeholder: "https://bitbucket.example.com" },
    }),
    token: text({
      title: "HTTP access token",
      description: "With repository write and project read permissions.",
      providerSettingsForm: { control: "password", secret: true },
    }),
  },
  { order: ["url", "token"] },
);
export type BitbucketServerSettings = typeof settings.Type;

export const definition = defineSourceControlClient({
  kind: KIND,
  label: "Bitbucket Data Center",
  pickerLabel: "Bitbucket Data Center",
  icon: "bitbucket",
  changeRequest: { shortLabel: "PR", singular: "pull request" },
  repositoryPathHint: "PROJECTKEY/repo-slug",
  publicHost: null,
  publishDescription: null,
  publishHost: (signedInHost) => signedInHost ?? "your server",
  newRepositoryOwner: () => null,
  defaultCloneTransport: "https",
  changeRequestUrl: ({ host, repository, number, remoteUrl }) =>
    changeRequestUrlFor(KIND, host, repository, number, remoteUrl),
  // Data Center declines and reopens through endpoints of its own. Draft is read-only on this
  // host, so neither direction of it is offered.
  changeRequestActions: new Set(["merge", "close", "reopen"] as const),
  checkoutCommand: () => null,
  authorProfileUrl: () => null,
  referenceAutolinkRepositoryUrl: () => null,
  reviewSummaryRequired: () => false,
  checkoutCommandArgument: () => null,
  isChangeRequestReference: () => false,
  changeRequestUrlHost: (url) => url.hostname,
  checkoutChangeRequestHost: () => null,
  isChangeRequestInRepository: (identity, link) =>
    isChangeRequestInProjectRepository(KIND, identity, link),
  canReadChangeRequestOnHost: (identity, link) =>
    isChangeRequestOnProjectHost(KIND, identity, link),
  isChangeRequestUrl: (url) => {
    try {
      return BITBUCKET_SERVER_PULL_REQUEST_PATH.test(new URL(url).pathname);
    } catch {
      return false;
    }
  },
  settings,
});
