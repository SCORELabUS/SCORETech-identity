import { useState } from "react";
import { AlertTriangle, Trash2 } from "lucide-react";
import {
  useResource,
  useAuth,
  useTask,
  config,
  Panel,
  Button,
  Dialog,
  Notice,
} from "@scoretech/ui";
import type { Profile } from "./profile-types";

export function DangerZone() {
  const { accountAction } = useAuth();
  const task = useTask();
  const resource = useResource<Profile>(config.accountApiUrl + "/me");
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      <Panel
        title="Delete your identity"
        description="Permanently close your SCORETech Identity account."
      >
        {task.feedback}
        {resource.error ? <Notice message={resource.error} /> : null}
        <div className="profile-privacy-note">
          <AlertTriangle size={21} />
          <div>
            <p>
              Deleting your identity removes your shared profile, connected
              sign-in providers, roles and sessions. You will lose access to
              services that use this identity.
            </p>
            <p>
              It does not delete your SPHERE or SPACE data. Manage service data,
              subscriptions and organization ownership in each service before
              deleting your identity.
            </p>
          </div>
        </div>
        {resource.data && !resource.data.capabilities?.accountDeletion ? (
          <Notice message="Administrative accounts are protected. Ask another administrator to remove your administrative access before deleting your identity." />
        ) : null}
        <Button
          variant="danger"
          disabled={!resource.data?.capabilities?.accountDeletion || task.busy}
          onClick={() => setConfirm(true)}
        >
          <Trash2 size={16} /> Delete my identity
        </Button>
      </Panel>
      {confirm ? (
        <Dialog
          title="Delete your SCORETech identity?"
          onClose={() => {
            if (!task.busy) setConfirm(false);
          }}
        >
          <p>
            This permanently removes your central identity and ends its
            sessions. Check your data and ownership in each SCORE service first.
          </p>
          <p>
            You will verify your identity and type your email address on the
            secure confirmation screen before anything is deleted.
          </p>
          <div className="form-actions">
            <Button
              variant="secondary"
              onClick={() => setConfirm(false)}
              disabled={task.busy}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={task.busy}
              onClick={() =>
                void task.execute("", () =>
                  accountAction("score-delete-account"),
                )
              }
            >
              Continue to verification
            </Button>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}
