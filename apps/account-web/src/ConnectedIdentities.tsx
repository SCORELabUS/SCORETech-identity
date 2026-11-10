import { useEffect, useRef } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Link2,
  Unlink,
  ShieldCheck,
} from "lucide-react";
import {
  useAuth,
  useResource,
  config,
  Panel,
  Button,
  Badge,
  Loading,
  Notice,
  Empty,
  useTask,
} from "@scoretech/ui";
import "./ConnectedIdentities.css";

interface ConnectedProvider {
  alias: string;
  displayName: string;
  enabled: boolean;
  linked: boolean;
  externalUsername?: string;
  canDisconnect: boolean;
  disconnectReason?: string;
}
interface ConnectedIdentitiesResponse {
  providers: ConnectedProvider[];
}

function ProviderMark({ alias }: { alias: string }) {
  const file =
    alias === "google"
      ? "google.svg"
      : alias === "us-sso"
        ? "universidad-sevilla.png"
        : undefined;
  return (
    <span
      className={`connected-identity-mark${alias === "us-sso" ? " connected-identity-mark-us" : ""}`}
      aria-hidden="true"
    >
      {file ? (
        <img src={config.baseUrl + "providers/" + file} alt="" />
      ) : (
        <Link2 size={25} />
      )}
    </span>
  );
}

export function ConnectedIdentities({ onBack }: { onBack: () => void }) {
  const { accountAction } = useAuth();
  const resource = useResource<ConnectedIdentitiesResponse>(
    config.accountApiUrl + "/identities",
  );
  const task = useTask();
  const heading = useRef<HTMLDivElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const providers = resource.data?.providers ?? [];
  const connected = providers.filter((provider) => provider.linked).length;
  const action = (name: string) =>
    void task.execute("", () => accountAction(name));

  return (
    <div className="connected-identities">
      <Button
        variant="quiet"
        className="security-back cursor-pointer"
        onClick={onBack}
      >
        <ArrowLeft size={16} /> Back to sign-in methods
      </Button>
      <div ref={heading} tabIndex={-1} className="connected-identities-heading">
        <Panel
          title="Connected identities"
          description="Connect different sign-in providers to the same SCORETech Identity account. Your profile, roles and permissions stay together."
          actions={<Badge>{connected} connected</Badge>}
        >
          {task.feedback}
          {resource.error ? <Notice message={resource.error} /> : null}
          {resource.loading && !resource.data ? <Loading /> : null}
          {resource.data && !providers.length ? (
            <Empty title="No external providers available">
              Google and Universidad de Sevilla will appear here when they are
              available for this service.
            </Empty>
          ) : null}
          <div className="connected-identity-list">
            {providers.map((provider) => {
              const unavailableReason =
                provider.linked && !provider.canDisconnect
                  ? provider.disconnectReason ||
                    "Add another sign-in method before disconnecting this identity."
                  : undefined;
              const reasonId =
                "identity-reason-" +
                provider.alias.replace(/[^a-zA-Z0-9_-]/g, "-");
              return (
                <article
                  className="connected-identity-card"
                  key={provider.alias}
                >
                  <div className="connected-identity-main">
                    <ProviderMark alias={provider.alias} />
                    <div className="connected-identity-details">
                      <h3>{provider.displayName}</h3>
                      <p>
                        {provider.linked
                          ? provider.externalUsername ||
                            "Linked to your account"
                          : "Use this provider to sign in to your existing account."}
                      </p>
                    </div>
                    <Badge tone={provider.linked ? "success" : "neutral"}>
                      {provider.linked ? "Connected" : "Not connected"}
                    </Badge>
                  </div>
                  <div className="connected-identity-bottom">
                    <p id={reasonId} className="connected-identity-note">
                      {unavailableReason ||
                        (!provider.enabled
                          ? "This provider is currently unavailable for sign-in."
                          : provider.linked
                            ? "Disconnecting removes this sign-in option, not your account."
                            : "You will sign in with the provider to confirm it belongs to you.")}
                    </p>
                    {provider.linked ? (
                      <Button
                        variant="secondary"
                        className="connected-identity-disconnect cursor-pointer"
                        aria-label={"Disconnect " + provider.displayName}
                        aria-describedby={reasonId}
                        disabled={task.busy || !provider.canDisconnect}
                        onClick={() =>
                          action("score-unlink-identity:" + provider.alias)
                        }
                      >
                        <Unlink size={16} /> Disconnect
                      </Button>
                    ) : (
                      <Button
                        variant="secondary"
                        className="cursor-pointer"
                        aria-label={"Connect " + provider.displayName}
                        aria-describedby={reasonId}
                        disabled={task.busy || !provider.enabled}
                        onClick={() => action("idp_link:" + provider.alias)}
                      >
                        Connect <ArrowUpRight size={16} />
                      </Button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
          {providers.some((p) => p.linked && !p.canDisconnect) ? (
            <Button
              variant="secondary"
              disabled={task.busy}
              className="connected-identities-verify cursor-pointer"
              onClick={() => action("VERIFY_EMAIL")}
            >
              Verify email address
            </Button>
          ) : null}
          <p className="connected-identities-security-note">
            <ShieldCheck size={18} aria-hidden="true" />
            Connecting a provider does not change your access permissions. Your
            administrative access still requires a passkey.
          </p>
        </Panel>
      </div>
    </div>
  );
}
