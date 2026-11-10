import {
  Heart,
  Leaf,
  Rocket,
  Sparkles,
  Star,
  Bot,
  Bird,
  Cat,
  Fish,
} from "lucide-react";
import { avatarArtwork } from "./avatar-assets";

export interface AvatarValue {
  kind: "initials" | "icon" | "preset" | "photo";
  backgroundColor?: string;
  foregroundColor?: string;
  assetId?: string;
  imageKey?: string;
  imageUrl?: string;
}
export const avatarPalette = [
  "#be1d37",
  "#94152a",
  "#212529",
  "#ffffff",
  "#343a40",
  "#68737d",
  "#a8a8a8",
  "#e5e5e5",
  "#fff8e0",
  "#ffd06a",
  "#ffb83e",
  "#ffa110",
  "#ff8105",
  "#ffd900",
  "#0d7660",
];
export const avatarChoices = [
  { id: "avatar-1", label: "Bear" },
  { id: "avatar-2", label: "Cat" },
  { id: "avatar-3", label: "Ghost" },
  { id: "avatar-4", label: "Owl" },
  { id: "avatar-6", label: "Bird" },
  { id: "avatar-7", label: "Skull" },
  { id: "avatar-8", label: "Alien" },
  { id: "avatar-9", label: "Robot" },
  { id: "avatar-10", label: "Dog" },
];
const colors: Record<string, string> = {
  graphite: "#212529",
  tentu: "#be1d37",
  stone: "#68737d",
  lime: "#ffd900",
  paper: "#ffffff",
  charcoal: "#343a40",
  cyan: "#00a6bf",
  pink: "#e472a8",
  purple: "#7654b2",
  orange: "#fa520f",
  black: "#000000",
  white: "#ffffff",
};
export const avatarColor = (value: string | undefined, fallback: string) =>
  value && /^#[a-f0-9]{6}$/i.test(value)
    ? value
    : colors[value || ""] || fallback;
export function Avatar({
  value,
  name,
  className = "",
}: {
  value?: AvatarValue;
  name: string;
  className?: string;
}) {
  const initials =
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0] || "")
      .join("")
      .toUpperCase() || "?";
  const foreground = avatarColor(value?.foregroundColor, "#ffffff");
  const artwork =
    value?.kind === "icon" && value.assetId
      ? avatarArtwork[value.assetId]
      : undefined;
  const legacy = {
    spark: Sparkles,
    rocket: Rocket,
    heart: Heart,
    leaf: Leaf,
    star: Star,
    owl: Bird,
    fox: Cat,
    octopus: Fish,
    robot: Bot,
  };
  const Icon = value?.assetId
    ? legacy[value.assetId as keyof typeof legacy]
    : undefined;
  return (
    <span
      className={`avatar user-avatar ${className}`}
      style={{
        backgroundColor: avatarColor(value?.backgroundColor, "#be1d37"),
        color: foreground,
      }}
    >
      {value?.kind === "photo" && value.imageUrl ? (
        <img src={value.imageUrl} alt="" />
      ) : artwork ? (
        <img
          src={
            "data:image/svg+xml;utf8," +
            encodeURIComponent(artwork.replace(/currentColor/g, foreground))
          }
          alt=""
        />
      ) : Icon && value?.kind !== "initials" ? (
        <Icon aria-hidden="true" />
      ) : (
        initials
      )}
    </span>
  );
}
