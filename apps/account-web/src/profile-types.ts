import type { AvatarValue } from "@scoretech/ui";
export interface SharedProfile {
  displayName: string;
  bio: string;
  city: string;
  country: string;
  dateOfBirth: string;
}
export interface SocialLinks {
  linkedin: string;
  instagram: string;
  facebook: string;
  x: string;
}
export interface Profile {
  id: string;
  firstName?: string;
  lastName?: string;
  email: string;
  emailVerified: boolean;
  phone?: string;
  roles: string[];
  permissions: string[];
  avatar: AvatarValue;
  profile: SharedProfile;
  socialLinks: SocialLinks;
  capabilities?: { avatarUpload: boolean; accountDeletion: boolean };
}
