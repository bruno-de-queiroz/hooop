import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface IdentityResponse {
  authenticated: boolean;
  fullName?: string | null;
  displayName?: string | null;
  role?: string | null;
  company?: string | null;
  emailAddress?: string | null;
  organizationName?: string | null;
  organizationRole?: string | null;
  organizationType?: string | null;
  seatTier?: string | null;
  accountUuid?: string | null;
  profileMarkdown?: string | null;
  profileSource?: string | null;
}

export function getIdentity(): IdentityResponse {
  const oauth = readOAuth();
  const profile = readProfile();

  const authenticated = oauth != null || profile != null;
  if (!authenticated) {
    return { authenticated: false };
  }

  return {
    authenticated: true,
    fullName: profile?.fields.name ?? null,
    displayName: oauth?.displayName ?? null,
    role: profile?.fields.role ?? null,
    company: profile?.fields.company ?? oauth?.organizationName ?? null,
    emailAddress: profile?.fields.email ?? oauth?.emailAddress ?? null,

    organizationName: oauth?.organizationName ?? null,
    organizationRole: oauth?.organizationRole ?? null,
    organizationType: oauth?.organizationType ?? null,
    seatTier: oauth?.seatTier ?? null,
    accountUuid: oauth?.accountUuid ?? null,

    profileMarkdown: profile?.body ?? null,
    profileSource: profile?.source ?? null,
  };
}

function readOAuth() {
  const path = join(homedir(), ".claude.json");
  if (!existsSync(path)) return null;
  try {
    const body = JSON.parse(readFileSync(path, "utf-8"));
    const oauth = body.oauthAccount ?? {};
    if (Object.keys(oauth).length === 0) return null;
    return oauth as Record<string, any>;
  } catch {
    return null;
  }
}

interface Profile {
  source: string;
  body: string;
  fields: { name?: string; role?: string; company?: string; email?: string };
}

function readProfile(): Profile | null {
  const candidates = [
    join(homedir(), ".claude", "hooop", "profile.md"),
    join(homedir(), ".claude", "hooop", "identity.md"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const body = readFileSync(path, "utf-8");
      return { source: path, body, fields: parseFields(body) };
    } catch {
      continue;
    }
  }
  return null;
}

function parseFields(md: string): Profile["fields"] {
  const get = (label: string) => {
    const re = new RegExp(`\\*\\*${label}:?\\*\\*\\s*([^\\n]+)`, "i");
    const m = md.match(re);
    return m ? m[1].trim() : undefined;
  };
  return {
    name: get("Name"),
    role: get("Role"),
    company: get("Company"),
    email: get("Email"),
  };
}
