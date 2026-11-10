// Adapted from SPHERE's settings/AvatarEditor: same initials, predefined artwork,
// paged selection, two color palettes and react-easy-crop photo workflow.
import { useCallback, useRef, useState, type ChangeEvent } from "react";
import Cropper, { type Area } from "react-easy-crop";
import { Camera, Upload, ChevronLeft, ChevronRight, Check } from "lucide-react";
import {
  Avatar,
  avatarPalette,
  avatarChoices,
  avatarColor,
  type AvatarValue,
  Button,
  Dialog,
  Notice,
  useAuth,
  config,
} from "@scoretech/ui";
import "./profile.css";

type Mode = "initials" | "predefined" | "upload";
const pageSize = 5;
export default function AvatarEditor({
  avatar,
  name,
  uploadEnabled,
  onSaved,
}: {
  avatar: AvatarValue;
  name: string;
  uploadEnabled: boolean;
  onSaved: () => void;
}) {
  const { api } = useAuth();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("initials");
  const [draft, setDraft] = useState(avatar);
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState(false);
  const [cropImage, setCropImage] = useState<string>();
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [pixelCrop, setPixelCrop] = useState<Area>();
  const input = useRef<HTMLInputElement>(null);
  const begin = () => {
    const legacyPresets: Record<string, string> = {
      owl: "avatar-4",
      fox: "avatar-2",
      octopus: "avatar-8",
      robot: "avatar-9",
    };
    setDraft(
      avatar.kind === "preset"
        ? {
            ...avatar,
            assetId: legacyPresets[avatar.assetId || ""] || avatarChoices[0].id,
          }
        : avatar,
    );
    setMode(
      avatar.kind === "photo"
        ? "upload"
        : avatar.kind === "initials"
          ? "initials"
          : "predefined",
    );
    setPage(
      Math.max(
        0,
        Math.floor(
          avatarChoices.findIndex((choice) => choice.id === avatar.assetId) /
            pageSize,
        ),
      ),
    );
    setError("");
    setRemoving(false);
    setOpen(true);
  };
  const saved = () => {
    window.dispatchEvent(new Event("score:profile-updated"));
    onSaved();
    setOpen(false);
    setCropImage(undefined);
  };
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const value: AvatarValue =
        mode === "initials"
          ? {
              kind: "initials",
              backgroundColor: draft.backgroundColor || "#be1d37",
              foregroundColor: draft.foregroundColor || "#ffffff",
            }
          : {
              kind: "icon",
              assetId: draft.assetId || avatarChoices[0].id,
              backgroundColor: draft.backgroundColor || "#be1d37",
              foregroundColor: draft.foregroundColor || "#ffffff",
            };
      await api(config.accountApiUrl + "/avatar", {
        method: "PATCH",
        body: JSON.stringify(value),
      });
      saved();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Unable to save your avatar.",
      );
    } finally {
      setBusy(false);
    }
  };
  const selectFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (
      !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
      file.size > 2 * 1024 * 1024
    ) {
      setError("Choose a JPEG, PNG or WebP image under 2 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setError("Unable to read this image.");
    reader.onload = () => {
      setCropImage(String(reader.result));
      setCrop({ x: 0, y: 0 });
      setZoom(1);
      setPixelCrop(undefined);
      setError("");
    };
    reader.readAsDataURL(file);
  };
  const cropComplete = useCallback(
    (_area: Area, pixels: Area) => setPixelCrop(pixels),
    [],
  );
  const saveCrop = async () => {
    if (!cropImage || !pixelCrop) return;
    setBusy(true);
    setError("");
    try {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("Unable to open this image."));
        image.src = cropImage;
      });
      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 256;
      const context = canvas.getContext("2d");
      if (!context)
        throw new Error("Image editing is unavailable in this browser.");
      context.drawImage(
        image,
        pixelCrop.x,
        pixelCrop.y,
        pixelCrop.width,
        pixelCrop.height,
        0,
        0,
        256,
        256,
      );
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (value) =>
            value
              ? resolve(value)
              : reject(new Error("Unable to crop this image.")),
          "image/webp",
          0.9,
        ),
      );
      await api(config.accountApiUrl + "/avatar-image", {
        method: "POST",
        headers: { "Content-Type": "image/webp" },
        body: blob,
      });
      saved();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Unable to upload your image.",
      );
    } finally {
      setBusy(false);
    }
  };
  const preview: AvatarValue =
    mode === "initials"
      ? { ...draft, kind: "initials" }
      : mode === "predefined"
        ? {
            ...draft,
            kind: "icon",
            assetId: draft.assetId || avatarChoices[0].id,
          }
        : avatar;
  return (
    <>
      <div className="profile-avatar-editor">
        <button
          type="button"
          className="profile-avatar-button cursor-pointer"
          aria-label="Edit avatar"
          onClick={begin}
        >
          <Avatar value={avatar} name={name} className="avatar-large" />
          <span className="profile-avatar-overlay">
            <Camera size={23} />
          </span>
        </button>
        <div>
          <strong>Your avatar</strong>
          <p>One familiar face across your SCORE services.</p>
          <Button type="button" variant="quiet" onClick={begin}>
            Edit avatar
          </Button>
        </div>
      </div>
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        hidden
        onChange={selectFile}
      />
      {open && !cropImage && !removing ? (
        <Dialog
          title="Edit avatar"
          onClose={() => {
            if (!busy) setOpen(false);
          }}
        >
          <div className="avatar-editor-content">
            <div className="avatar-preview">
              <Avatar value={preview} name={name} className="avatar-large" />
            </div>
            <fieldset disabled={busy} className="avatar-options">
              <legend>Options</legend>
              <div className="avatar-mode-options">
                <Button
                  variant="secondary"
                  aria-pressed={mode === "initials"}
                  onClick={() => setMode("initials")}
                >
                  Initials
                </Button>
                <Button
                  variant="secondary"
                  aria-pressed={mode === "predefined"}
                  onClick={() => setMode("predefined")}
                >
                  Predefined
                </Button>
                <Button
                  variant="secondary"
                  disabled={!uploadEnabled}
                  title={
                    uploadEnabled
                      ? undefined
                      : "Photo uploads are currently unavailable."
                  }
                  onClick={() => input.current?.click()}
                >
                  <Upload size={16} /> Upload image
                </Button>
              </div>
            </fieldset>
            {!uploadEnabled ? (
              <p className="avatar-help">
                Photo uploads are unavailable. You can still choose initials or
                a predefined avatar.
              </p>
            ) : null}
            {mode === "predefined" ? (
              <fieldset disabled={busy} className="avatar-options">
                <legend>Predefined avatars</legend>
                <div className="avatar-artwork-grid">
                  {avatarChoices
                    .slice(page * pageSize, (page + 1) * pageSize)
                    .map((choice) => (
                      <button
                        key={choice.id}
                        type="button"
                        aria-label={choice.label}
                        aria-pressed={preview.assetId === choice.id}
                        className="avatar-artwork-choice cursor-pointer"
                        onClick={() =>
                          setDraft({ ...draft, assetId: choice.id })
                        }
                      >
                        <Avatar
                          value={{ ...preview, assetId: choice.id }}
                          name={name}
                        />
                      </button>
                    ))}
                </div>
                <div className="avatar-pagination">
                  <Button
                    variant="quiet"
                    aria-label="Previous avatars"
                    disabled={page === 0}
                    onClick={() => setPage(page - 1)}
                  >
                    <ChevronLeft size={18} />
                  </Button>
                  <span>
                    {page + 1} / {Math.ceil(avatarChoices.length / pageSize)}
                  </span>
                  <Button
                    variant="quiet"
                    aria-label="Next avatars"
                    disabled={(page + 1) * pageSize >= avatarChoices.length}
                    onClick={() => setPage(page + 1)}
                  >
                    <ChevronRight size={18} />
                  </Button>
                </div>
              </fieldset>
            ) : null}
            {mode !== "upload" ? (
              <>
                {(["backgroundColor", "foregroundColor"] as const).map(
                  (key) => (
                    <fieldset
                      key={key}
                      disabled={busy}
                      className="avatar-options"
                    >
                      <legend>
                        {key === "backgroundColor"
                          ? "Background color"
                          : mode === "predefined"
                            ? "Icon color"
                            : "Text color"}
                      </legend>
                      <div className="avatar-colors">
                        {avatarPalette.map((color) => (
                          <button
                            key={color}
                            type="button"
                            aria-label={`${key === "backgroundColor" ? "Background" : "Foreground"} ${color}`}
                            aria-pressed={
                              avatarColor(
                                draft[key],
                                key === "backgroundColor"
                                  ? "#be1d37"
                                  : "#ffffff",
                              ) === color
                            }
                            style={{ backgroundColor: color }}
                            className="avatar-color-choice cursor-pointer"
                            onClick={() => setDraft({ ...draft, [key]: color })}
                          />
                        ))}
                      </div>
                    </fieldset>
                  ),
                )}
              </>
            ) : (
              <p className="avatar-help">
                Upload another image, or choose initials or a predefined avatar
                to replace this photo.
              </p>
            )}
            {error ? <Notice message={error} /> : null}
            <div className="avatar-editor-footer">
              <Button
                variant="quiet"
                className="avatar-remove"
                disabled={busy}
                onClick={() => setRemoving(true)}
              >
                Remove avatar
              </Button>
              <div className="form-actions">
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => setOpen(false)}
                >
                  Cancel
                </Button>
                {mode !== "upload" ? (
                  <Button disabled={busy} onClick={() => void save()}>
                    <Check size={16} />
                    {busy ? "Saving…" : "Save avatar"}
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        </Dialog>
      ) : null}
      {open && removing ? (
        <Dialog
          title="Remove your avatar?"
          onClose={() => {
            if (!busy) setRemoving(false);
          }}
        >
          <p>
            Your avatar will be replaced with your initials. An existing
            uploaded photo will be removed.
          </p>
          {error ? <Notice message={error} /> : null}
          <div className="form-actions">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setRemoving(false)}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError("");
                void api(config.accountApiUrl + "/avatar", {
                  method: "PATCH",
                  body: JSON.stringify({
                    kind: "initials",
                    backgroundColor: "#be1d37",
                    foregroundColor: "#ffffff",
                  }),
                })
                  .then(saved)
                  .catch((failure) =>
                    setError(
                      failure instanceof Error
                        ? failure.message
                        : "Unable to remove avatar.",
                    ),
                  )
                  .finally(() => setBusy(false));
              }}
            >
              Remove avatar
            </Button>
          </div>
        </Dialog>
      ) : null}
      {open && cropImage ? (
        <Dialog
          title="Crop your avatar"
          onClose={() => {
            if (!busy) {
              setCropImage(undefined);
              setError("");
            }
          }}
        >
          <div className="avatar-editor-content">
            <p className="avatar-help">
              Drag to position your image. Use the zoom slider to adjust the
              crop.
            </p>
            <div className="avatar-crop-area">
              <Cropper
                image={cropImage}
                crop={crop}
                zoom={zoom}
                aspect={1}
                cropShape="rect"
                onCropChange={setCrop}
                onZoomChange={setZoom}
                onCropComplete={cropComplete}
                onMediaLoaded={() => setError("")}
              />
            </div>
            <label className="avatar-zoom">
              Zoom
              <input
                type="range"
                className="cursor-pointer"
                min={1}
                max={3}
                step={0.05}
                value={zoom}
                disabled={busy}
                onChange={(event) => setZoom(Number(event.target.value))}
              />
            </label>
            {error ? <Notice message={error} /> : null}
            <div className="form-actions">
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setCropImage(undefined);
                  setError("");
                }}
              >
                Cancel
              </Button>
              <Button
                disabled={busy || !pixelCrop}
                onClick={() => void saveCrop()}
              >
                {busy ? "Saving…" : "Save image"}
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}
