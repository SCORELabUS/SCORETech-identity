import { useEffect, useState, type FormEvent } from "react";
import { ShieldCheck, Link2 } from "lucide-react";
import {
  useResource,
  useAuth,
  useTask,
  config,
  Panel,
  Field,
  Button,
  Loading,
  Notice,
} from "@scoretech/ui";
import AvatarEditor from "./AvatarEditor";
import type { Profile } from "./profile-types";
import "./profile.css";

export function SharedProfilePanel() {
  const resource = useResource<Profile>(config.accountApiUrl + "/me");
  if (!resource.data)
    return resource.error ? <Notice message={resource.error} /> : <Loading />;
  return (
    <SharedProfileForm profile={resource.data} onSaved={resource.reload} />
  );
}
function SharedProfileForm({
  profile,
  onSaved,
}: {
  profile: Profile;
  onSaved: () => void;
}) {
  const { api } = useAuth();
  const task = useTask();
  const [details, setDetails] = useState(profile.profile);
  const [links, setLinks] = useState(profile.socialLinks);
  const dirty =
    JSON.stringify(details) !== JSON.stringify(profile.profile) ||
    JSON.stringify(links) !== JSON.stringify(profile.socialLinks);
  useEffect(() => {
    if (!dirty) return;
    const leave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, [dirty]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void task.execute("Your shared profile has been updated.", async () => {
      await api(config.accountApiUrl + "/profile", {
        method: "PATCH",
        body: JSON.stringify({ profile: details, socialLinks: links }),
      });
      window.dispatchEvent(new Event("score:profile-updated"));
      onSaved();
    });
  };
  return (
    <>
      <Panel
        title="Profile and avatar"
        description="Choose how you introduce yourself across the SCORE ecosystem."
      >
        <AvatarEditor
          avatar={profile.avatar}
          name={
            [profile.firstName, profile.lastName].filter(Boolean).join(" ") ||
            profile.email
          }
          uploadEnabled={Boolean(profile.capabilities?.avatarUpload)}
          onSaved={onSaved}
        />
        {task.feedback}
        <form className="shared-profile-section" onSubmit={submit}>
          <div className="form-grid">
            <Field
              label="Display name"
              hint="The name services can use when showing your profile."
            >
              <input
                maxLength={100}
                value={details.displayName}
                onChange={(event) =>
                  setDetails({ ...details, displayName: event.target.value })
                }
              />
            </Field>
            <Field
              label="Date of birth"
              hint="Optional personal information. It is not published as part of a public profile."
            >
              <input
                type="date"
                min="1900-01-01"
                max={new Date().toISOString().slice(0, 10)}
                value={details.dateOfBirth}
                onChange={(event) =>
                  setDetails({ ...details, dateOfBirth: event.target.value })
                }
              />
            </Field>
            <Field label="City">
              <input
                maxLength={100}
                autoComplete="address-level2"
                value={details.city}
                onChange={(event) =>
                  setDetails({ ...details, city: event.target.value })
                }
              />
            </Field>
            <Field label="Country">
              <input
                maxLength={100}
                autoComplete="country-name"
                value={details.country}
                onChange={(event) =>
                  setDetails({ ...details, country: event.target.value })
                }
              />
            </Field>
          </div>
          <Field label="Bio" hint={`${details.bio.length}/200 characters`}>
            <textarea
              maxLength={200}
              rows={3}
              placeholder="Tell us a little about yourself…"
              value={details.bio}
              onChange={(event) =>
                setDetails({ ...details, bio: event.target.value })
              }
            />
          </Field>
          <div>
            <h3 className="shared-social-heading">
              <Link2 size={18} /> Social links
            </h3>
            <p className="avatar-help">Optional links to your profiles.</p>
          </div>
          <div className="form-grid">
            {(
              [
                [
                  "linkedin",
                  "LinkedIn",
                  "https://linkedin.com/in/your-profile",
                ],
                [
                  "instagram",
                  "Instagram",
                  "https://instagram.com/your-profile",
                ],
                ["facebook", "Facebook", "https://facebook.com/your-profile"],
                ["x", "X (Twitter)", "https://x.com/your-handle"],
              ] as const
            ).map(([key, label, placeholder]) => (
              <Field label={label} key={key}>
                <input
                  type="url"
                  maxLength={500}
                  placeholder={placeholder}
                  value={links[key]}
                  onChange={(event) =>
                    setLinks({ ...links, [key]: event.target.value })
                  }
                />
              </Field>
            ))}
          </div>
          <p className="profile-privacy-note">
            <ShieldCheck size={18} />
            Your profile is stored in SCORETech Identity. Your personal details
            are not published automatically. Each SCORE service controls how it
            displays your profile.
          </p>
          <div className="form-actions">
            <Button
              variant="secondary"
              type="button"
              disabled={!dirty || task.busy}
              onClick={() => {
                setDetails(profile.profile);
                setLinks(profile.socialLinks);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!dirty || task.busy}>
              {task.busy ? "Saving…" : "Save profile"}
            </Button>
          </div>
        </form>
      </Panel>
    </>
  );
}
